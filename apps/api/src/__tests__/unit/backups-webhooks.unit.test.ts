import { readFile, stat } from 'node:fs/promises';
import { backupPrefixSchema, createWebhookSchema, updateBackupSettingsSchema } from '@oci/shared';
import { describe, expect, it, vi } from 'vitest';
import { pgConnectionFromUrl, pgToolPath, scrubSecret } from '../../services/backups/pg-tools.js';
import { isoWeekKey, selectBackupsToKeep } from '../../services/backups/retention.js';
import { scheduledSlot } from '../../services/backups/run.js';
import {
  applyBackupSettingsPatch,
  changedBackupFields,
  normalizeBackupSettings,
  toPublicBackupSettings,
} from '../../services/backups/settings.js';
import { retryDelayMs, WEBHOOK_LIMITS, webhookPayload } from '../../services/webhooks/delivery.js';
import { actionSelected, generateWebhookSecret } from '../../services/webhooks/endpoints.js';
import { signWebhook, verifyWebhookSignature } from '../../services/webhooks/signing.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('backup retention', () => {
  const at = (iso: string, id = iso) => ({ id, startedAt: new Date(iso) });

  it('keeps the newest backup of each recent day and week', () => {
    const runs = [
      at('2026-10-02T03:00:00Z'),
      at('2026-10-02T01:00:00Z'), // same day, older
      at('2026-10-01T03:00:00Z'),
      at('2026-09-30T03:00:00Z'),
      at('2026-09-24T03:00:00Z'), // previous ISO week
      at('2026-09-16T03:00:00Z'), // two weeks back
      at('2026-08-01T03:00:00Z'),
    ];
    expect([...selectBackupsToKeep(runs, 2, 0)].sort()).toEqual(
      ['2026-10-01T03:00:00Z', '2026-10-02T03:00:00Z'].sort(),
    );
    const keep = selectBackupsToKeep(runs, 1, 3);
    expect([...keep].sort()).toEqual(
      ['2026-10-02T03:00:00Z', '2026-09-24T03:00:00Z', '2026-09-16T03:00:00Z'].sort(),
    );
    // Always at least the newest one.
    expect([...selectBackupsToKeep(runs, 0, 0)]).toEqual(['2026-10-02T03:00:00Z']);
    expect(selectBackupsToKeep([], 7, 4).size).toBe(0);
  });

  it('counts ISO weeks across year ends', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2026-10-04T23:00:00Z'))).toBe('2026-W40'); // Sunday
    expect(isoWeekKey(new Date('2026-10-05T00:00:00Z'))).toBe('2026-W41'); // Monday
  });

  it('finds the most recent scheduled slot', () => {
    expect(scheduledSlot(new Date('2026-10-02T05:00:00Z'), 3).toISOString()).toBe(
      '2026-10-02T03:00:00.000Z',
    );
    expect(scheduledSlot(new Date('2026-10-02T02:59:00Z'), 3).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    expect(scheduledSlot(new Date('2026-10-02T03:00:00Z'), 3).toISOString()).toBe(
      '2026-10-02T03:00:00.000Z',
    );
  });
});

describe('backup settings', () => {
  it('defaults to off, the attachment bucket, a week of dailies and a month of weeklies', () => {
    const settings = normalizeBackupSettings({});
    expect(settings).toMatchObject({
      enabled: false,
      hourUtc: 3,
      destination: 'storage',
      prefix: 'oci-backups/',
      keepDaily: 7,
      keepWeekly: 4,
    });
    expect(toPublicBackupSettings(settings).s3.hasCredential).toBe(false);
  });

  it('copies files for a new configuration, not for one saved before v0.10', () => {
    expect(normalizeBackupSettings({})).toMatchObject({ copyFiles: true, verifyFiles: 'sample' });
    expect(normalizeBackupSettings({ enabled: true, destination: 'storage' })).toMatchObject({
      copyFiles: false,
    });
    expect(normalizeBackupSettings({ enabled: true, copyFiles: true }).copyFiles).toBe(true);
    const before = normalizeBackupSettings({ enabled: false });
    const after = applyBackupSettingsPatch(before, { copyFiles: true, verifyFiles: 'all' });
    expect(changedBackupFields(before, after)).toEqual(['copyFiles', 'verifyFiles']);
    expect(toPublicBackupSettings(after)).toMatchObject({ copyFiles: true, verifyFiles: 'all' });
    expect(updateBackupSettingsSchema.safeParse({ verifyFiles: 'some' }).success).toBe(false);
  });

  it('keeps secrets write-only and reports which fields changed', () => {
    const before = normalizeBackupSettings({});
    const after = applyBackupSettingsPatch(before, {
      enabled: true,
      s3: { bucket: 'backups', secretAccessKey: 'super-secret-value' },
    });
    expect(after.s3.encryptedSecretAccessKey).toBeTruthy();
    expect(after.s3.encryptedSecretAccessKey).not.toContain('super-secret-value');
    expect(JSON.stringify(toPublicBackupSettings(after))).not.toContain('super-secret');
    expect(changedBackupFields(before, after)).toEqual([
      'enabled',
      's3.bucket',
      's3.secretAccessKey',
    ]);
    // Blank keeps, null clears.
    expect(
      applyBackupSettingsPatch(after, { s3: { secretAccessKey: '' } }).s3.encryptedSecretAccessKey,
    ).toBe(after.s3.encryptedSecretAccessKey);
    expect(
      applyBackupSettingsPatch(after, { s3: { secretAccessKey: null } }).s3
        .encryptedSecretAccessKey,
    ).toBeNull();
  });

  it('validates prefixes and settings bodies', () => {
    for (const ok of ['oci-backups/', 'a/b.c/', 'x_1/'])
      expect(backupPrefixSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['/root/', 'no-slash', '../up/', 'a/../b/', 'a b/', ''])
      expect(backupPrefixSchema.safeParse(bad).success, bad).toBe(false);
    expect(updateBackupSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateBackupSettingsSchema.safeParse({ hourUtc: 24 }).success).toBe(false);
    expect(updateBackupSettingsSchema.safeParse({ keepDaily: 0 }).success).toBe(false);
    expect(
      updateBackupSettingsSchema.safeParse({ s3: { endpoint: 'https://k:s@x.test' } }).success,
    ).toBe(false);
    expect(updateBackupSettingsSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});

describe('pg_dump connection', () => {
  it('passes the connection in libpq variables and the password only in a private file', async () => {
    const connection = await pgConnectionFromUrl(
      'postgres://oci%40app:p%3Ass%5Cw:rd@db.internal:6543/oci_prod?sslmode=verify-full',
    );
    try {
      expect(connection.env).toMatchObject({
        PGHOST: 'db.internal',
        PGPORT: '6543',
        PGUSER: 'oci@app',
        PGDATABASE: 'oci_prod',
        PGSSLMODE: 'verify-full',
      });
      expect(JSON.stringify(connection.env)).not.toContain('p:ss');
      expect(connection.env.PGPASSWORD).toBeUndefined();
      expect(Object.keys(connection.env)).not.toContain('ENCRYPTION_KEY');
      const file = connection.env.PGPASSFILE!;
      expect(await readFile(file, 'utf8')).toBe('*:*:*:oci@app:p\\:ss\\\\w\\:rd\n');
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect(connection.password).toBe('p:ss\\w:rd');
    } finally {
      await connection.cleanup();
    }
    await expect(stat(connection.env.PGPASSFILE!)).rejects.toThrow();
  });

  it('handles URLs without a password, ssl=true, and refuses other schemes', async () => {
    const connection = await pgConnectionFromUrl('postgresql://localhost/oci?ssl=true');
    expect(connection.env).toMatchObject({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGDATABASE: 'oci',
      PGSSLMODE: 'require',
    });
    expect(connection.env.PGPASSFILE).toBe('/dev/null');
    expect(connection.password).toBeNull();
    await connection.cleanup();
    await expect(pgConnectionFromUrl('mysql://x/y')).rejects.toThrow(/postgres/);
    await expect(pgConnectionFromUrl('not a url')).rejects.toThrow(/valid URL/);
  });

  it('scrubs the password from output and resolves the tools', () => {
    expect(scrubSecret('auth failed for p@ss and p%40ss', 'p@ss')).toBe(
      'auth failed for *** and ***',
    );
    expect(scrubSecret('nothing', null)).toBe('nothing');
    expect(pgToolPath('pg_dump', '/usr/lib/postgresql/17/bin')).toBe(
      '/usr/lib/postgresql/17/bin/pg_dump',
    );
    expect(pgToolPath('pg_restore', undefined)).toBe('pg_restore');
  });
});

describe('webhook signatures', () => {
  const secret = generateWebhookSecret();
  const body = '{"id":"1","type":"user.create"}';
  const now = Date.UTC(2026, 9, 2, 12);
  const timestamp = Math.floor(now / 1000);

  it('signs timestamp and body with HMAC-SHA256 and verifies within the tolerance', () => {
    const signature = signWebhook(secret, timestamp, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    const check = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
      verifyWebhookSignature({
        secret,
        signature,
        timestamp: String(timestamp),
        body,
        now,
        ...overrides,
      });
    expect(check({})).toBe(true);
    expect(check({ signature: `v1=${'0'.repeat(64)}, ${signature}` })).toBe(true);
    expect(check({ body: `${body} ` })).toBe(false);
    expect(check({ timestamp: String(timestamp + 1) })).toBe(false);
    expect(check({ secret: generateWebhookSecret() })).toBe(false);
    expect(check({ now: now + 301_000 })).toBe(false);
    expect(check({ timestamp: 'soon' })).toBe(false);
    expect(check({ signature: 'v1=short' })).toBe(false);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });

  it('selects actions exactly or by prefix', () => {
    const endpoint = { allActions: false, actions: ['user.*', 'backup.run'] };
    expect(actionSelected(endpoint, 'user.create')).toBe(true);
    expect(actionSelected(endpoint, 'user.bulk.ban')).toBe(true);
    expect(actionSelected(endpoint, 'backup.run')).toBe(true);
    expect(actionSelected(endpoint, 'backup.settings.update')).toBe(false);
    expect(actionSelected(endpoint, 'users.create')).toBe(false);
    expect(actionSelected({ allActions: true, actions: [] }, 'anything')).toBe(true);
  });

  it('builds the payload from audit metadata only, and backs off exponentially', () => {
    const payload = JSON.parse(
      webhookPayload({
        id: 'a1',
        action: 'tool.call',
        createdAt: new Date(now),
        actorUserId: null,
        actorEmail: null,
        targetType: null,
        targetId: null,
        metadata: null,
      }),
    );
    expect(payload).toEqual({
      id: 'a1',
      type: 'tool.call',
      createdAt: new Date(now).toISOString(),
      actor: null,
      target: null,
      metadata: {},
    });
    expect([1, 2, 3, 7, 8, 20].map(retryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(WEBHOOK_LIMITS.maxAttempts).toBe(8);
  });

  it('validates endpoint bodies', () => {
    const base = { url: 'https://hooks.example.test/oci', actions: ['user.*'] };
    expect(createWebhookSchema.safeParse(base).success).toBe(true);
    expect(createWebhookSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ ...base, actions: [], allActions: true }).success).toBe(
      true,
    );
    expect(createWebhookSchema.safeParse({ ...base, actions: ['User Create'] }).success).toBe(
      false,
    );
    expect(createWebhookSchema.safeParse({ ...base, actions: ['*'] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ ...base, url: 'https://a:b@x.test/' }).success).toBe(
      false,
    );
    expect(createWebhookSchema.safeParse({ ...base, url: 'https://x.test/#frag' }).success).toBe(
      false,
    );
    expect(createWebhookSchema.safeParse({ ...base, secret: 'mine' }).success).toBe(false);
  });
});
