import { eq, schema } from '@oci/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type BackupsContext, useBackupsSuite } from '../../../test/backups.fixtures.js';
import { findPgBinDir, liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Automated backups end to end: real PostgreSQL, the real pg_dump and
 * pg_restore, an S3-compatible server (MinIO locally, VersityGW in CI) as both
 * attachment storage and backup destination, and the real admin routes.
 * The admin routes and the schedule.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
  env: {} as Record<string, unknown>,
  logs: [] as unknown[],
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
});
vi.mock('../../lib/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      state.logs.push([level, ...args]);
  return {
    logger: {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
    },
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));
// Every spawned program passes through here so the test can inspect its arguments and environment.
const spawned = vi.hoisted(
  () => [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: { env?: Record<string, string> }) => {
      spawned.push({ command, args, env: { ...(options?.env ?? {}) } });
      return actual.spawn(command, args, options as never);
    },
  };
});

// Required everywhere, CI included (it installs the PostgreSQL 17 client tools).
const pgBinDir = findPgBinDir();
if (!pgBinDir)
  throw new Error(
    'pg_dump and pg_restore are required for the backup live tests. Install the PostgreSQL client tools (for example `brew install libpq`) or set BACKUP_PG_BIN_DIR.',
  );
const available = (await livePostgresAvailable()) && (await liveS3Available()) && Boolean(pgBinDir);

describe.skipIf(!available)('live: automated backups', () => {
  const suite = useBackupsSuite(state, spawned, pgBinDir);
  const { separateBucket, call } = suite;
  let pool: BackupsContext['pool'];
  let auditor: BackupsContext['auditor'];
  let backups: BackupsContext['backups'];
  let s3: BackupsContext['s3'];
  beforeAll(() => {
    ({ pool, auditor, backups, s3 } = suite.ctx);
  });

  it('serves status, settings, run now and a destination test to admins; auditors only read', async () => {
    let response = await call('GET', '/api/admin/backups', { user: auditor });
    expect(response.status).toBe(200);
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      pgDumpVersion: expect.stringMatching(/pg_dump/),
      settings: { enabled: false },
    });

    response = await call('PATCH', '/api/admin/backups/settings', {
      user: auditor,
      body: { enabled: true },
    });
    expect(response.status).toBe(403);

    // Turning on is refused while the destination is incomplete.
    response = await call('PATCH', '/api/admin/backups/settings', {
      body: { enabled: true, destination: 'separate', s3: { bucket: separateBucket } },
    });
    expect(response.status).toBe(422);

    response = await call('PATCH', '/api/admin/backups/settings', {
      body: {
        enabled: true,
        destination: 'separate',
        prefix: 'via-api/',
        hourUtc: 4,
        keepDaily: 3,
        s3: {
          bucket: separateBucket,
          region: 'us-east-1',
          endpoint: liveS3Config.endpoint,
          accessKeyId: liveS3Config.accessKeyId,
          secretAccessKey: liveS3Config.secretAccessKey,
          forcePathStyle: true,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as { settings: Record<string, unknown> };
    expect(saved.settings).toMatchObject({
      enabled: true,
      hourUtc: 4,
      s3: { hasCredential: true },
    });
    expect(JSON.stringify(saved)).not.toContain(liveS3Config.secretAccessKey);
    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.settings.update'));
    expect((audit!.metadata as { fields: string[] }).fields).toContain('s3.secretAccessKey');
    expect(JSON.stringify(audit)).not.toContain(liveS3Config.secretAccessKey);

    response = await call('POST', '/api/admin/backups/test');
    expect(await response.json()).toMatchObject({ ok: true });
    // Audited, as every Test button is (#287).
    const tests = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.test'));
    expect(tests.map((entry) => entry.metadata)).toEqual([{ ok: true }]);

    await pool.db.delete(schema.backupRun);
    response = await call('POST', '/api/admin/backups/run');
    expect(response.status).toBe(202);
    // The run continues in the background; wait for it to finish.
    let finished: { status: string; dumpKey: string | null } | undefined;
    for (let attempt = 0; attempt < 120 && !finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [row] = await pool.db.select().from(schema.backupRun);
      if (row && row.status !== 'running') finished = row;
    }
    expect(finished?.status).toBe('succeeded');
    expect(finished?.dumpKey).toMatch(/^via-api\//);

    // Today's slot is now covered by a successful backup, so the schedule waits.
    expect(await backups.runScheduledBackup(new Date(Date.now() + 1000))).toBe(0);
    response = await call('GET', '/api/admin/backups');
    const after = (await response.json()) as {
      runs: unknown[];
      lastSuccessAt: string;
      nextRunAt: string;
    };
    expect(after.runs).toHaveLength(1);
    expect(after.lastSuccessAt).toBeTruthy();
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const { backupHealthCheck } = await import('../../services/observability/health-checks.js');
    expect(await backupHealthCheck()).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/could not be read/),
    });
  });

  it('runs on schedule only when on and the slot is not yet covered', async () => {
    await pool.db.delete(schema.backupRun);
    state.settings.set('backups', { enabled: false, destination: 'storage' });
    expect(await backups.runScheduledBackup()).toBe(0);
    const { backupHealthCheck } = await import('../../services/observability/health-checks.js');
    expect(await backupHealthCheck()).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^Off/),
    });
    state.settings.set('backups', { enabled: true, destination: 'storage', hourUtc: 0 });
    expect(await backups.runScheduledBackup()).toBe(1);
    expect(await backups.runScheduledBackup()).toBe(0);
    const [run] = await pool.db.select().from(schema.backupRun);
    expect(run).toMatchObject({ trigger: 'schedule', status: 'succeeded' });
    for (const key of [run!.dumpKey, run!.manifestKey, run!.attachmentsKey])
      if (key) await s3.delete(key);
  });
});
