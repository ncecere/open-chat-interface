import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read routing (v0.11 design, section 11): heavy administrative reads go to
 * READ_DATABASE_URL only while the replica has replayed what the primary had
 * written READ_DATABASE_MAX_LAG_MS ago; otherwise, and when the replica fails
 * a read, to the primary.
 */
const mocks = vi.hoisted(() => ({
  env: {
    READ_DATABASE_URL: 'postgres://replica.test/oci' as string | undefined,
    READ_DATABASE_MAX_LAG_MS: 1_000,
  },
  primaryLsn: 0,
  replicaLsn: 0 as number | null,
  replicaFails: false,
  replicaDb: { name: 'replica' },
  end: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
const lsn = (value: number) =>
  `${Math.floor(value / 2 ** 32).toString(16)}/${(value % 2 ** 32).toString(16)}`;

vi.mock('../../config/env.js', () => ({ loadEnv: () => mocks.env }));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/observability/metrics.js', () => ({ registerCollectedGauge: vi.fn() }));
vi.mock('../../db/index.js', () => ({
  sql: async () => [{ lsn: lsn(mocks.primaryLsn) }],
}));
vi.mock('@oci/db', () => ({
  createDatabase: () => ({
    db: mocks.replicaDb,
    sql: Object.assign(
      async () => {
        if (mocks.replicaFails) throw Object.assign(new Error('gone'), { code: 'ECONNREFUSED' });
        return [{ lsn: mocks.replicaLsn === null ? null : lsn(mocks.replicaLsn) }];
      },
      { end: mocks.end },
    ),
  }),
}));

import {
  closeReadReplica,
  onReadReplica,
  parseLsn,
  readRouting,
  readRoutingStatus,
} from '../../db/read.js';
import { routedDatabase, scopedDatabase, withDatabase } from '../../db/routing.js';

/** Where `work` ran: the replica's database, or the primary (no scope). */
const where = () => onReadReplica(async () => (scopedDatabase() ? 'replica' : 'primary'));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.env.READ_DATABASE_URL = 'postgres://replica.test/oci';
  mocks.primaryLsn = 1_000;
  mocks.replicaLsn = 1_000;
  mocks.replicaFails = false;
});
afterEach(async () => {
  await closeReadReplica();
  vi.useRealTimers();
});

describe('read routing', () => {
  it('parses LSNs into comparable numbers', () => {
    expect(parseLsn('0/16B3748')).toBe(0x16b3748n);
    expect(parseLsn('1/0') > parseLsn('0/FFFFFFFF')).toBe(true);
  });

  it('reads from the primary without READ_DATABASE_URL', async () => {
    mocks.env.READ_DATABASE_URL = undefined;
    expect(await where()).toBe('primary');
    expect(readRoutingStatus()).toBeNull();
  });

  it('uses a replica only once it is known to be within the bound', async () => {
    // Nothing is known yet: the first read goes to the primary.
    expect(await where()).toBe('primary');
    await vi.advanceTimersByTimeAsync(1_300);
    expect(await where()).toBe('replica');
    expect(readRoutingStatus()).toMatchObject({ inUse: true, routed: { replica: 1, primary: 1 } });
  });

  it('goes back to the primary while the replica lags, and returns when it catches up', async () => {
    await where();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(await where()).toBe('replica');
    // The primary keeps writing; the replica stops replaying.
    const writing = setInterval(() => {
      mocks.primaryLsn += 100;
    }, 50);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await where()).toBe('primary');
    expect(mocks.info).toHaveBeenCalledWith({ fresh: false }, expect.stringContaining('behind'));
    clearInterval(writing);
    mocks.replicaLsn = mocks.primaryLsn;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await where()).toBe('replica');
  });

  it('treats a replica that never replayed anything as behind', async () => {
    mocks.replicaLsn = null;
    await where();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await where()).toBe('primary');
  });

  it('runs a read again on the primary when the replica fails it, then stays away a while', async () => {
    await where();
    await vi.advanceTimersByTimeAsync(1_300);
    let attempts = 0;
    const result = await onReadReplica(async () => {
      attempts++;
      if (scopedDatabase())
        throw Object.assign(new Error('conflict with recovery'), { code: '40001' });
      return 'primary answer';
    });
    expect(result).toBe('primary answer');
    expect(attempts).toBe(2);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(await where()).toBe('primary');
    await vi.advanceTimersByTimeAsync(readRouting.backoffMs + 300);
    expect(await where()).toBe('replica');
  });

  it('does not hide other errors', async () => {
    await where();
    await vi.advanceTimersByTimeAsync(1_300);
    await expect(
      onReadReplica(async () => {
        throw new Error('a bug');
      }),
    ).rejects.toThrow('a bug');
  });

  it('stops trusting a replica it cannot reach, and stops checking when idle', async () => {
    await where();
    await vi.advanceTimersByTimeAsync(1_300);
    mocks.replicaFails = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(await where()).toBe('primary');
    mocks.replicaFails = false;
    await vi.advanceTimersByTimeAsync(readRouting.idleStopMs + 1_000);
    // Sampling stopped: nothing is known again until reads resume.
    expect(readRoutingStatus()).toMatchObject({ inUse: false, checkedAt: null });
    expect(await where()).toBe('primary');
  });

  it('routes the shared db to the database of the scope, with methods bound to it', async () => {
    const make = (name: string) => ({
      name,
      who() {
        return this.name;
      },
    });
    const primary = make('primary');
    const replica = make('replica');
    const db = routedDatabase(primary as never) as unknown as typeof primary;
    expect(db.who()).toBe('primary');
    expect(await withDatabase(replica as never, async () => db.who())).toBe('replica');
    expect(db.name).toBe('primary');
  });

  it('nests: work already scoped stays where it is', async () => {
    await where();
    await vi.advanceTimersByTimeAsync(1_300);
    const inner = await onReadReplica(() =>
      onReadReplica(async () => (scopedDatabase() as unknown) === mocks.replicaDb),
    );
    expect(inner).toBe(true);
  });
});
