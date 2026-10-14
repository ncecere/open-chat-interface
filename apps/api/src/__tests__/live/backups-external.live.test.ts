import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, schema, sql } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BackupsContext, sha, useBackupsSuite } from '../../../test/backups.fixtures.js';
import {
  ensureBucket,
  findPgBinDir,
  liveS3Available,
  liveS3Config,
} from '../../../test/live-backup-tools.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * The external database backup mode (`databaseBackup: 'external'`): a run
 * builds the attachment manifest, copies and reads back files, applies
 * retention and the sweep, and never starts pg_dump or pg_restore, never opens
 * a control connection and does not need the client tools. Real PostgreSQL,
 * S3 and the real admin routes; a `spawn` spy proves nothing is started and
 * `BACKUP_PG_BIN_DIR` names an empty directory.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
  env: {} as Record<string, unknown>,
  logs: [] as unknown[],
  /** Read and write instance settings through the real service (the rolling-upgrade test). */
  realSettings: false,
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
vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...actual,
    getSetting: async (key: string) =>
      state.realSettings
        ? actual.getSetting(key as never)
        : structuredClone(state.settings.get(key) ?? {}),
    updateSetting: async (key: string, patch: Record<string, unknown>) => {
      if (state.realSettings) return actual.updateSetting(key as never, patch as never);
      const next = { ...((state.settings.get(key) ?? {}) as object), ...patch };
      state.settings.set(key, next);
      return next;
    },
  };
});
// Every spawned program passes through here so the test can see what was started.
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

// The dump half of the mode-switch test needs the tools; everything else must work without them.
const pgBinDir = findPgBinDir();
if (!pgBinDir)
  throw new Error(
    'pg_dump and pg_restore are required for the backup live tests. Install the PostgreSQL client tools (for example `brew install libpq`) or set BACKUP_PG_BIN_DIR.',
  );
const available = (await livePostgresAvailable()) && (await liveS3Available()) && Boolean(pgBinDir);

describe.skipIf(!available)('live: external database backup', () => {
  const suite = useBackupsSuite(state, spawned, pgBinDir);
  const { attachmentKeys, call } = suite;
  let pool: BackupsContext['pool'];
  let auditor: BackupsContext['auditor'];
  let backups: BackupsContext['backups'];
  let s3: BackupsContext['s3'];
  let tmp: BackupsContext['tmp'];
  let noTools = '';
  const bucket = `oci-test-external-${randomUUID().slice(0, 8)}`;
  let files: import('../../services/storage/s3-driver.js').S3StorageDriver;
  const sources = new Map<string, Buffer>();

  beforeAll(async () => {
    ({ pool, auditor, backups, s3, tmp } = suite.ctx);
    noTools = join(tmp, 'no-tools');
    await mkdir(noTools);
    await ensureBucket(bucket);
    const { S3StorageDriver } = await import('../../services/storage/s3-driver.js');
    files = new S3StorageDriver({ ...liveS3Config, bucket });
    for (const key of attachmentKeys) sources.set(key, await s3.get(key));
  });

  // Every test starts as an operator without the PostgreSQL client tools.
  beforeEach(() => {
    state.env = { ...state.env, BACKUP_PG_BIN_DIR: noTools };
    state.realSettings = false;
  });

  async function target(prefix: string) {
    const { encryptSecret } = await import('../../lib/crypto.js');
    return {
      destination: 'separate',
      prefix,
      s3: {
        bucket,
        region: 'us-east-1',
        endpoint: liveS3Config.endpoint,
        accessKeyId: liveS3Config.accessKeyId,
        encryptedSecretAccessKey: encryptSecret(liveS3Config.secretAccessKey),
        forcePathStyle: true,
      },
    };
  }

  const copyOf = (prefix: string, body: Buffer) => `${prefix}objects/${sha(body)}`;
  const parseLines = (body: Buffer) =>
    body
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  /** A database URL that cannot connect: an external run must not need one. */
  const unreachableDatabase = 'postgres://nobody:not-a-password@127.0.0.1:1/none';

  it('refuses without pg_dump only in dump mode, and shows no client-tool issue in external mode', async () => {
    // Dump mode (the default): the tools are required to turn backups on.
    let response = await call('GET', '/api/admin/backups', { user: auditor });
    let status = (await response.json()) as {
      settings: Record<string, unknown>;
      issues: string[];
      pgDumpVersion: string | null;
    };
    expect(status.settings).toMatchObject({ databaseBackup: 'dump', walArchivingExpected: true });
    expect(status.pgDumpVersion).toBeNull();
    expect(status.issues.join(' ')).toMatch(/pg_dump was not found/);
    response = await call('PATCH', '/api/admin/backups/settings', { body: { enabled: true } });
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/pg_dump was not found/);

    // External mode: nothing to install, and nothing is started to find out.
    spawned.length = 0;
    response = await call('PATCH', '/api/admin/backups/settings', {
      body: { databaseBackup: 'external', enabled: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    status = (await response.json()) as typeof status;
    expect(status.settings).toMatchObject({ databaseBackup: 'external', enabled: true });
    expect(status.issues).toEqual([]);
    expect(status.pgDumpVersion).toBeNull();
    response = await call('GET', '/api/admin/backups', { user: auditor });
    expect(((await response.json()) as typeof status).issues).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('audits the mode as a changed field, rejects other values, and keeps it for auditors read-only', async () => {
    state.settings.set('backups', { enabled: false, destination: 'storage' });
    let response = await call('PATCH', '/api/admin/backups/settings', {
      body: { databaseBackup: 'external', walArchivingExpected: false },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { settings: object }).settings).toMatchObject({
      databaseBackup: 'external',
      walArchivingExpected: false,
    });
    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.settings.update'))
      .orderBy(sql`${schema.auditLog.createdAt} desc`)
      .limit(1);
    expect((audit!.metadata as { fields: string[] }).fields).toEqual([
      'databaseBackup',
      'walArchivingExpected',
    ]);

    // Saving the same value again changes nothing and is not audited again.
    const before = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.settings.update'));
    response = await call('PATCH', '/api/admin/backups/settings', {
      body: { databaseBackup: 'external' },
    });
    expect(response.status).toBe(200);
    expect(
      await pool.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'backup.settings.update')),
    ).toHaveLength(before.length);

    response = await call('PATCH', '/api/admin/backups/settings', {
      body: { databaseBackup: 'snapshot' },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    response = await call('PATCH', '/api/admin/backups/settings', {
      user: auditor,
      body: { databaseBackup: 'dump' },
    });
    expect(response.status).toBe(403);
  });

  it('is dump, with archiving expected, for every stored setting from before; and survives a v0.12 replica saving other fields', async () => {
    const { normalizeBackupSettings } = await import('../../services/backups/settings.js');
    expect(normalizeBackupSettings({})).toMatchObject({
      databaseBackup: 'dump',
      walArchivingExpected: true,
    });
    for (const stored of [
      {},
      { enabled: true, destination: 'storage' },
      { enabled: true, copyFiles: true, verifyFiles: 'all', keepDaily: 3 },
    ] as const) {
      state.settings.set('backups', stored);
      const response = await call('GET', '/api/admin/backups', { user: auditor });
      expect(((await response.json()) as { settings: object }).settings).toMatchObject({
        databaseBackup: 'dump',
        walArchivingExpected: true,
      });
    }

    // Rolling upgrade: a v0.13 replica stored `external`; a v0.12 replica then saves
    // its other backup fields, which it writes without the new keys.
    const real = await vi.importActual<typeof import('../../services/settings.js')>(
      '../../services/settings.js',
    );
    state.realSettings = true;
    try {
      await real.updateSetting('backups', {
        enabled: true,
        destination: 'storage',
        databaseBackup: 'external',
        walArchivingExpected: false,
      });
      await real.updateSetting('backups', {
        enabled: true,
        hourUtc: 5,
        destination: 'storage',
        prefix: 'oci-backups/',
        s3: {},
        keepDaily: 7,
        keepWeekly: 4,
        copyFiles: true,
        verifyFiles: 'sample',
      });
      real.invalidateSettingsCache('backups');
      const [row] = await pool.db
        .select({ value: schema.instanceSetting.value })
        .from(schema.instanceSetting)
        .where(eq(schema.instanceSetting.key, 'backups'));
      expect(row!.value).toMatchObject({
        hourUtc: 5,
        databaseBackup: 'external',
        walArchivingExpected: false,
      });
      expect(await real.getSetting('backups')).toMatchObject({ databaseBackup: 'external' });
    } finally {
      await pool.db.delete(schema.instanceSetting).where(eq(schema.instanceSetting.key, 'backups'));
      real.invalidateSettingsCache('backups');
      state.realSettings = false;
    }
  });

  it('backs up attachments without pg_dump, pg_restore or a database connection of its own', async () => {
    await pool.db.delete(schema.backupRun);
    state.settings.set('backups', {
      ...(await target('ext/')),
      databaseBackup: 'external',
      copyFiles: true,
      verifyFiles: 'all',
    });
    const { backupRuns } = await import('../../services/observability/metrics.js');
    const counted = () => backupRuns.get({ outcome: 'succeeded' });
    const succeededBefore = counted();
    spawned.length = 0;

    const run = await backups.performBackup({
      trigger: 'manual',
      actor: { id: suite.ctx.admin, email: 'admin@example.test' },
      databaseUrl: unreachableDatabase,
    });

    expect(spawned).toEqual([]);
    expect(run).toMatchObject({
      status: 'succeeded',
      verified: true,
      dumpKey: null,
      dumpBytes: null,
      dumpSha256: null,
      attachmentCount: 3,
      missingObjects: 1,
      copiedObjects: 3,
      verifiedObjects: 3,
    });
    expect(run.verificationDetail).toBe(
      'Database: backed up outside OCI, not checked by OCI; 3 attachment objects checksummed, 1 missing; 3 files copied, 0 already at the destination, 3 read back and checksummed',
    );
    // Only the attachment manifest and the manifest were written; no dump anywhere.
    const folder = run.manifestKey!.replace(/manifest\.json$/, '');
    expect(await files.exists(`${folder}database.dump`)).toBe(false);
    const manifest = JSON.parse((await files.get(run.manifestKey!)).toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'oci-backup/1',
      database: { external: true },
      attachments: { objects: 3, missingObjects: 1, storage: 's3' },
      files: { copied: true, copiedObjects: 3 },
    });
    expect(manifest.database).toEqual({ external: true });
    // Files are copied by content and read back.
    for (const key of attachmentKeys) {
      const body = sources.get(key)!;
      expect((await files.get(copyOf('ext/', body))).equals(body)).toBe(true);
    }
    expect(parseLines(await files.get(run.attachmentsKey!))).toHaveLength(4);

    // Audit and metrics are as for a dump, without a dump size.
    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, run.id));
    expect(audit).toMatchObject({ action: 'backup.run', actorUserId: suite.ctx.admin });
    expect(audit!.metadata).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      database: 'external',
      attachmentObjects: 3,
      copiedObjects: 3,
      verified: true,
    });
    expect(audit!.metadata).not.toHaveProperty('dumpBytes');
    expect(counted()).toBe(succeededBefore + 1);
    expect(JSON.stringify(state.logs)).not.toContain('not-a-password');

    // The history the page reads shows no database size to print.
    const response = await call('GET', '/api/admin/backups', { user: auditor });
    const status = (await response.json()) as { runs: Array<Record<string, unknown>> };
    expect(status.runs.find((entry) => entry.id === run.id)).toMatchObject({
      dumpKey: null,
      dumpBytes: null,
      dumpSha256: null,
      verified: true,
    });
  });

  it('works with attachment copying off: a checksum list and nothing else', async () => {
    state.settings.set('backups', {
      ...(await target('ext-plain/')),
      databaseBackup: 'external',
      copyFiles: false,
    });
    const run = await backups.performBackup({ trigger: 'schedule' });
    expect(run).toMatchObject({
      status: 'succeeded',
      dumpKey: null,
      attachmentCount: 3,
      copiedObjects: null,
    });
    expect(run.verificationDetail).toBe(
      'Database: backed up outside OCI, not checked by OCI; 3 attachment objects checksummed, 1 missing',
    );
    const manifest = JSON.parse((await files.get(run.manifestKey!)).toString('utf8'));
    expect(manifest).toMatchObject({ database: { external: true }, files: { copied: false } });
    expect(await files.exists('ext-plain/objects/')).toBe(false);
  });

  it('fails a run whose stored copy no longer matches, and records no dump for it', async () => {
    state.settings.set('backups', {
      ...(await target('ext-bad/')),
      databaseBackup: 'external',
      copyFiles: true,
      verifyFiles: 'all',
    });
    const damaged = copyOf('ext-bad/', sources.get(attachmentKeys[2]!)!);
    await files.put(damaged, randomBytes(2049), 'application/octet-stream');
    spawned.length = 0;
    await expect(backups.performBackup({ trigger: 'manual' })).rejects.toThrow(
      /Verification failed: 1 of 3 copied attachment files/,
    );
    expect(spawned).toEqual([]);
    const [failed] = await pool.db
      .select()
      .from(schema.backupRun)
      .where(eq(schema.backupRun.status, 'failed'))
      .orderBy(sql`${schema.backupRun.startedAt} desc`)
      .limit(1);
    expect(failed).toMatchObject({ dumpKey: null, manifestKey: null });
    expect(failed!.errorMessage).toMatch(/Verification failed/);
    await files.delete(damaged);
  });

  it('applies retention and the sweep as in dump mode, and lets earlier dumps expire after a switch', async () => {
    await pool.db.delete(schema.backupRun);
    state.settings.set('backups', {
      ...(await target('ext-ret/')),
      copyFiles: true,
      keepDaily: 1,
      keepWeekly: 0,
    });

    // Before the switch: a dump run, with the tools.
    state.env = { ...state.env, BACKUP_PG_BIN_DIR: pgBinDir };
    const dumped = await backups.performBackup({ trigger: 'manual' });
    expect(dumped.dumpKey).toMatch(/database\.dump$/);
    expect(await files.exists(dumped.dumpKey!)).toBe(true);

    // After it: switching deletes nothing by itself...
    state.env = { ...state.env, BACKUP_PG_BIN_DIR: noTools };
    state.settings.set('backups', {
      ...(state.settings.get('backups') as object),
      databaseBackup: 'external',
    });
    expect(await files.exists(dumped.dumpKey!)).toBe(true);

    // ...the next run's retention does, as it always has: the dump goes with its backup.
    const first = await backups.performBackup({ trigger: 'manual' });
    expect(first.dumpKey).toBeNull();
    expect(
      (await pool.db.select().from(schema.backupRun).where(eq(schema.backupRun.id, dumped.id)))[0]
        ?.prunedAt,
    ).not.toBeNull();
    expect(await files.exists(dumped.dumpKey!)).toBe(false);
    expect(await files.exists(dumped.manifestKey!)).toBe(false);

    // An external run is itself pruned without a dump key to delete.
    const stray = `ext-ret/objects/${sha(randomBytes(8))}`;
    await files.put(stray, Buffer.from('stray'), 'application/octet-stream');
    spawned.length = 0;
    const second = await backups.performBackup({ trigger: 'manual', sweepGraceMs: 0 });
    expect(spawned).toEqual([]);
    expect(
      (await pool.db.select().from(schema.backupRun).where(eq(schema.backupRun.id, first.id)))[0]
        ?.prunedAt,
    ).not.toBeNull();
    expect(await files.exists(first.manifestKey!)).toBe(false);
    expect(await files.exists(first.attachmentsKey!)).toBe(false);
    expect(await files.exists(second.manifestKey!)).toBe(true);
    // The sweep removed the stray object and kept every copy the retained run lists.
    expect(second.sweptObjects).toBe(1);
    expect(await files.exists(stray)).toBe(false);
    for (const key of attachmentKeys)
      expect(await files.exists(copyOf('ext-ret/', sources.get(key)!)), key).toBe(true);
  });

  it('restores attachment files from an external run with backup:restore-files', async () => {
    const { restoreAttachmentFiles } = await import('../../services/backups/restore-files.js');
    const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
    const [latest] = await pool.db
      .select()
      .from(schema.backupRun)
      .where(eq(schema.backupRun.keyPrefix, 'ext-ret/'))
      .orderBy(sql`${schema.backupRun.startedAt} desc`)
      .limit(1);
    const local = new LocalStorageDriver(join(tmp, 'restore-external'));
    const dry = await restoreAttachmentFiles({
      backup: files,
      folder: latest!.manifestKey!.replace(/manifest\.json$/, ''),
      target: local,
      dryRun: true,
    });
    expect(dry).toMatchObject({ restored: sources.size, failed: [] });
    const result = await restoreAttachmentFiles({
      backup: files,
      folder: latest!.manifestKey!.replace(/manifest\.json$/, ''),
      target: local,
    });
    expect(result).toMatchObject({ restored: sources.size, missingInBackup: 1, failed: [] });
    for (const [key, body] of sources) expect((await local.get(key)).equals(body), key).toBe(true);
  });
  it('shows the database row and the WAL metrics only in external mode, and words the Backups row without a size', async () => {
    const { backupHealthCheck } = await import('../../services/observability/health-checks.js');
    const { registerCollectedGauges } = await import('../../services/observability/collected.js');
    const { renderMetrics } = await import('../../services/observability/metrics.js');
    registerCollectedGauges();
    const ids = async () => {
      const response = await call('GET', '/api/admin/health', { user: auditor });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { checks: Array<Record<string, string>> }).checks;
    };
    await pool.db.delete(schema.backupRun);

    // Dump mode: no row, no series.
    state.settings.set('backups', { enabled: true, destination: 'storage' });
    expect((await ids()).some((check) => check.id === 'database-backup')).toBe(false);
    let metrics = await renderMetrics();
    expect(metrics).not.toMatch(/^oci_wal_archive_failing /m);

    // External mode against this server (no archiving): a warning, naming what OCI cannot tell.
    state.settings.set('backups', { enabled: false, databaseBackup: 'external' });
    let row = (await ids()).find((check) => check.id === 'database-backup')!;
    expect(row).toMatchObject({ label: 'Database backup (external)', status: 'warn' });
    expect(row.detail).toMatch(/^WAL archiving is off, so point-in-time recovery is not possible/);
    expect(row.detail).toMatch(/Not verified by OCI: that a base backup exists/);
    // Also with scheduled backups off, and ok when archiving is not expected.
    state.settings.set('backups', {
      enabled: false,
      databaseBackup: 'external',
      walArchivingExpected: false,
    });
    row = (await ids()).find((check) => check.id === 'database-backup')!;
    expect(row).toMatchObject({ status: 'ok' });
    expect(row.detail).toMatch(/^WAL archiving is off, as configured/);
    metrics = await renderMetrics();
    expect(metrics).toMatch(/^oci_wal_archive_failing 0$/m);
    // Nothing was ever archived here: the success timestamp is absent.
    expect(metrics).not.toMatch(/^oci_wal_archive_last_success_timestamp_seconds \d/m);

    // The Backups row says the database is backed up outside OCI, not "0.0 KB database".
    state.settings.set('backups', {
      ...(await target('ext-health/')),
      enabled: true,
      databaseBackup: 'external',
    });
    await backups.performBackup({ trigger: 'manual' });
    const backupRow = await backupHealthCheck();
    // (A warning here: the fixture has one attachment whose object is gone.)
    expect(backupRow).toMatchObject({ status: 'warn' });
    expect(backupRow.detail).toMatch(/, database backed up outside OCI, 3 attachment objects/);
    expect(backupRow.detail).not.toMatch(/KB database|unknown size/);
  });
});
