import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  MigrationLockTimeoutError,
  migrationRetryDelay,
  migrationTimeoutsFromEnv,
} from '@oci/db';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.js';

const required = {
  DATABASE_URL: 'postgres://oci:secret@postgres:5432/oci',
  AUTH_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(64),
};

describe('migration timeouts from the environment', () => {
  it('defaults to a 3s lock timeout and a 15 minute statement timeout', () => {
    expect(migrationTimeoutsFromEnv({})).toEqual({
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 900_000,
      idleInTransactionTimeoutMs: 10_000,
    });
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(3_000);
    expect(DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS).toBe(900_000);
    // Blank means unset, as Compose passes `${NAME:-}`.
    expect(
      migrationTimeoutsFromEnv({
        MIGRATION_LOCK_TIMEOUT_MS: ' ',
        MIGRATION_STATEMENT_TIMEOUT_MS: '',
      }),
    ).toMatchObject({ lockTimeoutMs: 3_000, statementTimeoutMs: 900_000 });
  });

  it('reads configured values, including 0 to disable the statement timeout', () => {
    expect(
      migrationTimeoutsFromEnv({
        MIGRATION_LOCK_TIMEOUT_MS: '5000',
        MIGRATION_STATEMENT_TIMEOUT_MS: '0',
      }),
    ).toMatchObject({ lockTimeoutMs: 5_000, statementTimeoutMs: 0 });
  });

  it('rejects values outside the bounds the API validates', () => {
    for (const value of ['0', '99', '600001', '1.5', 'soon']) {
      expect(() => migrationTimeoutsFromEnv({ MIGRATION_LOCK_TIMEOUT_MS: value })).toThrow(
        /MIGRATION_LOCK_TIMEOUT_MS/,
      );
      expect(() => parseEnv({ ...required, MIGRATION_LOCK_TIMEOUT_MS: value })).toThrow(
        /MIGRATION_LOCK_TIMEOUT_MS/,
      );
    }
    expect(() => migrationTimeoutsFromEnv({ MIGRATION_STATEMENT_TIMEOUT_MS: '-1' })).toThrow(
      /MIGRATION_STATEMENT_TIMEOUT_MS/,
    );
    expect(() => parseEnv({ ...required, MIGRATION_STATEMENT_TIMEOUT_MS: '-1' })).toThrow(
      /MIGRATION_STATEMENT_TIMEOUT_MS/,
    );
  });

  it('parses the same defaults and values in the API environment', () => {
    expect(parseEnv(required)).toMatchObject({
      MIGRATION_LOCK_TIMEOUT_MS: 3_000,
      MIGRATION_STATEMENT_TIMEOUT_MS: 900_000,
    });
    expect(
      parseEnv({
        ...required,
        MIGRATION_LOCK_TIMEOUT_MS: '2000',
        MIGRATION_STATEMENT_TIMEOUT_MS: '0',
      }),
    ).toMatchObject({ MIGRATION_LOCK_TIMEOUT_MS: 2_000, MIGRATION_STATEMENT_TIMEOUT_MS: 0 });
  });
});

describe('migration retry backoff', () => {
  it('doubles from the base delay up to the ceiling', () => {
    const middle = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => migrationRetryDelay(n, 1_000, 30_000, middle))).toEqual(
      [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
    );
  });

  it('spreads retries by at most 25% either way', () => {
    expect(migrationRetryDelay(1, 1_000, 30_000, () => 0)).toBe(750);
    expect(migrationRetryDelay(1, 1_000, 30_000, () => 1)).toBe(1_250);
  });

  it('spans a few minutes over the default ten attempts', () => {
    const total = Array.from({ length: 9 }, (_, i) =>
      migrationRetryDelay(i + 1, 1_000, 30_000, () => 0.5),
    ).reduce((sum, delay) => sum + delay, 0);
    // Nine pauses plus ten 3s lock waits: about three minutes.
    expect(total + 10 * 3_000).toBeGreaterThan(120_000);
    expect(total + 10 * 3_000).toBeLessThan(300_000);
  });
});

describe('MigrationLockTimeoutError', () => {
  const cause = Object.assign(new Error('canceling statement due to lock timeout'), {
    code: '55P03',
  });

  it('names the relation, lock mode, blocking session and statement', () => {
    const error = new MigrationLockTimeoutError({
      attempts: 10,
      lockTimeoutMs: 3_000,
      statement: 'ALTER TABLE "message"\n  ADD COLUMN "x" text',
      cause,
      lockWait: {
        locktype: 'relation',
        mode: 'AccessExclusiveLock',
        relation: 'public.message',
        blockers: [
          {
            pid: 4242,
            state: 'idle in transaction',
            applicationName: 'pg_dump',
            transactionStart: '2026-10-04T10:00:00Z',
            query: 'COPY public.message (id, parts) TO stdout;',
          },
        ],
      },
    });
    expect(error.name).toBe('MigrationLockTimeoutError');
    expect(error.cause).toBe(cause);
    expect(error.attempts).toBe(10);
    expect(error.message).toContain('gave up after 10 attempts');
    expect(error.message).toContain('3000ms');
    expect(error.message).toContain('AccessExclusiveLock on public.message');
    expect(error.message).toContain(
      'pid 4242 (idle in transaction, transaction started 2026-10-04T10:00:00Z, application "pg_dump"): COPY public.message',
    );
    expect(error.message).toContain('Statement: ALTER TABLE "message" ADD COLUMN "x" text');
  });

  it('still explains itself when the blocker was not observed', () => {
    const error = new MigrationLockTimeoutError({
      attempts: 2,
      lockTimeoutMs: 500,
      statement: undefined,
      cause,
      lockWait: null,
    });
    expect(error.message).toContain('gave up after 2 attempts');
    expect(error.message).toContain('could not be identified');
    expect(error.message).not.toContain('Statement:');
  });

  it('describes a non-relation lock and a blocker without details', () => {
    const error = new MigrationLockTimeoutError({
      attempts: 3,
      lockTimeoutMs: 500,
      statement: 'x'.repeat(400),
      cause,
      lockWait: {
        locktype: 'transactionid',
        mode: 'ShareLock',
        relation: null,
        blockers: [
          { pid: 7, state: null, applicationName: null, transactionStart: null, query: null },
        ],
      },
    });
    expect(error.message).toContain('ShareLock on a transactionid lock');
    expect(error.message).toContain('pid 7 (unknown state)');
    expect(error.message).toContain(`${'x'.repeat(299)}…`);
  });
});
