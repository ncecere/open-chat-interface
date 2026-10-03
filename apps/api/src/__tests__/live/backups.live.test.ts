import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureBucket,
  findPgBinDir,
  liveS3Available,
  liveS3Config,
} from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Automated backups end to end: real PostgreSQL, the real pg_dump and
 * pg_restore, MinIO as both attachment storage and backup destination, and
 * the real admin routes.
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

const pgBinDir = findPgBinDir();
if (!pgBinDir && !process.env.CI)
  throw new Error(
    'pg_dump and pg_restore are required for the backup live tests. Install the PostgreSQL client tools (for example `brew install libpq`) or set BACKUP_PG_BIN_DIR.',
  );
const available = (await livePostgresAvailable()) && (await liveS3Available()) && Boolean(pgBinDir);

describe.skipIf(!available)('live: automated backups', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let auditor: string;
  let app: Hono<AppBindings>;
  let backups: typeof import('../../services/backups/run.js');
  let s3: import('../../services/storage/s3-driver.js').S3StorageDriver;
  let password: string;
  const separateBucket = `oci-test-backups-${randomUUID().slice(0, 8)}`;
  const attachmentKeys: string[] = [];
  let tmp: string;

  async function storageSettings() {
    const { encryptSecret } = await import('../../lib/crypto.js');
    return {
      driver: 's3',
      maxFileBytes: 10_000_000,
      maxFilesPerMessage: 5,
      allowedMimeTypes: [],
      s3: {
        bucket: liveS3Config.bucket,
        region: liveS3Config.region,
        endpoint: liveS3Config.endpoint,
        accessKeyId: liveS3Config.accessKeyId,
        encryptedSecretAccessKey: encryptSecret(liveS3Config.secretAccessKey),
        forcePathStyle: true,
      },
    };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('backups');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    password = decodeURIComponent(new URL(live.connectionString).password);
    state.env = { DATABASE_URL: live.connectionString, BACKUP_PG_BIN_DIR: pgBinDir };
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    auditor = await seedUser(pool.db, state.organizationId, { role: 'auditor' });
    await ensureBucket(separateBucket);
    tmp = await mkdtemp(join(tmpdir(), 'oci-backup-test-'));

    backups = await import('../../services/backups/run.js');
    const { S3StorageDriver } = await import('../../services/storage/s3-driver.js');
    s3 = new S3StorageDriver(liveS3Config);

    // Two attachments with objects (one with a thumbnail) and one whose object is gone.
    for (const [index, withThumb] of [
      [0, true],
      [1, false],
    ] as const) {
      const key = `live-backup/${randomUUID()}/file-${index}.bin`;
      const body = randomBytes(2048 + index);
      await s3.put(key, body, 'application/octet-stream');
      attachmentKeys.push(key);
      let thumb: string | null = null;
      if (withThumb) {
        thumb = `${key}.thumb.webp`;
        await s3.put(thumb, randomBytes(100), 'image/webp');
        attachmentKeys.push(thumb);
      }
      await pool.db.execute(sql`
        insert into attachment (organization_id, user_id, filename, mime_type, size_bytes, storage_key, thumbnail_key)
        values (${state.organizationId}, ${admin}, ${'secret-name.pdf'}, 'application/pdf', ${body.byteLength}, ${key}, ${thumb})
      `);
    }
    await pool.db.execute(sql`
      insert into attachment (organization_id, user_id, filename, mime_type, size_bytes, storage_key)
      values (${state.organizationId}, ${admin}, 'gone.pdf', 'application/pdf', 10, ${`live-backup/${randomUUID()}/missing.bin`})
    `);

    const { adminRoutes } = await import('../../routes/admin/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      const id = c.req.header('x-test-user');
      const role = id === admin ? 'admin' : 'auditor';
      c.set(
        'user',
        id
          ? {
              id,
              name: 'Test',
              email: `${role}@example.test`,
              image: null,
              role,
              emailVerified: true,
              organizationId: state.organizationId,
            }
          : null,
      );
      await next();
    });
    app.route('/api/admin', adminRoutes);
  });

  beforeEach(async () => {
    state.settings.clear();
    state.settings.set('storage', await storageSettings());
    state.logs.length = 0;
    spawned.length = 0;
  });

  afterAll(async () => {
    for (const key of attachmentKeys) await s3?.delete(key).catch(() => {});
    if (tmp) await rm(tmp, { recursive: true, force: true });
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function call(
    method: string,
    path: string,
    { user = admin, body }: { user?: string; body?: unknown } = {},
  ) {
    return app.request(path, {
      method,
      headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function download(bucket: string, key: string): Promise<Buffer> {
    const { S3StorageDriver } = await import('../../services/storage/s3-driver.js');
    return new S3StorageDriver({ ...liveS3Config, bucket }).get(key);
  }

  const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

  it('dumps the database to S3 in a form pg_restore reads, with a correct attachment manifest', async () => {
    state.settings.set('backups', { enabled: true, destination: 'storage' });
    const run = await backups.performBackup({
      trigger: 'manual',
      actor: { id: admin, email: 'admin@example.test' },
    });

    expect(run.status).toBe('succeeded');
    expect(run.verified).toBe(true);
    expect(run.dumpKey).toMatch(/^\.oci-backups\/.+\/database\.dump$/);
    expect(run.verificationDetail).toMatch(/archive entries, \d+ tables/);

    // Independently of OCI's own verification: download and list it.
    const dump = await download(liveS3Config.bucket, run.dumpKey!);
    expect(dump.byteLength).toBe(run.dumpBytes);
    expect(sha(dump)).toBe(run.dumpSha256);
    const file = join(tmp, 'database.dump');
    await writeFile(file, dump);
    const listing = execFileSync(join(pgBinDir!, 'pg_restore'), ['--list', file], {
      encoding: 'utf8',
    });
    expect(listing).toMatch(/TABLE public audit_log/);
    expect(listing).toMatch(/TABLE DATA public attachment/);

    // The manifest: every object with its real size and checksum, the missing one flagged.
    const lines = (
      await download(
        liveS3Config.bucket,
        run.dumpKey!.replace('database.dump', 'attachments.jsonl'),
      )
    )
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(4);
    for (const key of attachmentKeys) {
      const entry = lines.find((line) => line.key === key)!;
      const body = await download(liveS3Config.bucket, key);
      expect(entry).toMatchObject({ bytes: body.byteLength, sha256: sha(body) });
    }
    expect(lines.filter((line) => line.missing)).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('secret-name.pdf');
    expect(run).toMatchObject({ attachmentCount: 3, missingObjects: 1 });

    const manifest = JSON.parse(
      (await download(liveS3Config.bucket, run.manifestKey!)).toString('utf8'),
    );
    expect(manifest).toMatchObject({
      format: 'oci-backup/1',
      database: { key: run.dumpKey, bytes: run.dumpBytes, sha256: run.dumpSha256 },
      attachments: { objects: 3, missingObjects: 1, storage: 's3' },
    });

    // Checksums are cached so the next run reads only new objects.
    const cached = await pool.db.select().from(schema.backupObjectChecksum);
    expect(cached.map((row) => row.storageKey).sort()).toEqual([...attachmentKeys].sort());

    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'backup.run'));
    expect(audit).toMatchObject({ actorUserId: admin, targetId: run.id });
    expect(audit!.metadata).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      verified: true,
    });

    // pg_dump and pg_restore never see the password: not in arguments, not in their environment.
    const tools = spawned.filter((entry) => /pg_(dump|restore)$/.test(entry.command));
    expect(tools.map((entry) => entry.command.split('/').at(-1))).toEqual(
      expect.arrayContaining(['pg_dump', 'pg_restore']),
    );
    for (const entry of tools) {
      expect(JSON.stringify(entry.args)).not.toContain(password);
      expect(JSON.stringify(entry.env)).not.toContain(password);
      expect(entry.env.PGPASSWORD).toBeUndefined();
      expect(entry.env.ENCRYPTION_KEY).toBeUndefined();
    }
    const dumpCall = tools.find((entry) => entry.command.endsWith('pg_dump'))!;
    expect(dumpCall.args).toEqual(['--format=custom', '--no-password']);
    expect(dumpCall.env.PGPASSFILE).toMatch(/oci-pg-/);
    // The password file is removed once the dump ends.
    await expect(stat(dumpCall.env.PGPASSFILE!)).rejects.toThrow();
    expect(JSON.stringify(state.logs)).not.toContain(password);

    await s3.delete(run.dumpKey!);
    await s3.delete(run.manifestKey!);
    await s3.delete(run.dumpKey!.replace('database.dump', 'attachments.jsonl'));
  });

  it('streams large objects in bounded parts and never stores a stream whose source failed', async () => {
    const MiB = 1024 * 1024;
    const key = `live-backup/${randomUUID()}/big.bin`;
    const chunks = Array.from({ length: 11 }, () => randomBytes(MiB));
    async function* source() {
      for (const chunk of chunks) yield chunk;
    }
    const stored = await s3.putStream(key, source(), 'application/octet-stream', {
      partSizeBytes: 5 * MiB,
    });
    expect(stored.sizeBytes).toBe(11 * MiB);
    expect(sha(await s3.get(key))).toBe(sha(Buffer.concat(chunks)));
    await s3.delete(key);

    for (const size of [6 * MiB, 1024]) {
      const failing = `live-backup/${randomUUID()}/failed.bin`;
      async function* broken() {
        yield randomBytes(size);
        throw new Error('producer failed');
      }
      await expect(
        s3.putStream(failing, broken(), 'application/octet-stream', { partSizeBytes: 5 * MiB }),
      ).rejects.toThrow('producer failed');
      expect(await s3.exists(failing)).toBe(false);
    }
  });

  it('writes to a separate bucket under its prefix, and refuses the attachment bucket as one', async () => {
    const { encryptSecret } = await import('../../lib/crypto.js');
    const target = {
      bucket: separateBucket,
      region: 'us-east-1',
      endpoint: liveS3Config.endpoint,
      accessKeyId: liveS3Config.accessKeyId,
      encryptedSecretAccessKey: encryptSecret(liveS3Config.secretAccessKey),
      forcePathStyle: true,
    };
    state.settings.set('backups', { destination: 'separate', prefix: 'site/oci/', s3: target });
    const run = await backups.performBackup({ trigger: 'schedule' });
    expect(run.status).toBe('succeeded');
    expect(run.dumpKey).toMatch(/^site\/oci\/.+\/database\.dump$/);
    expect((await download(separateBucket, run.dumpKey!)).byteLength).toBe(run.dumpBytes);

    const { backupConfigurationIssues, normalizeBackupSettings } = await import(
      '../../services/backups/settings.js'
    );
    const issues = await backupConfigurationIssues(
      normalizeBackupSettings({
        destination: 'separate',
        s3: { ...target, bucket: liveS3Config.bucket },
      }),
    );
    expect(issues.join(' ')).toMatch(/attachment bucket/);
  });

  it('keeps the newest backup per day and week, and deletes the objects of the rest', async () => {
    state.settings.set('backups', { destination: 'storage', keepDaily: 2, keepWeekly: 1 });
    await pool.db.delete(schema.backupRun);
    const days = [0, 1, 1, 3, 10];
    const runs: Array<{ id: string; key: string }> = [];
    for (const [index, ago] of days.entries()) {
      const key = `.oci-backups/retention-${index}-${randomUUID()}/database.dump`;
      await s3.put(key, Buffer.from(`dump ${index}`), 'application/octet-stream');
      const startedAt = new Date(Date.UTC(2026, 8, 30, 12 - index) - ago * 86_400_000);
      const [row] = await pool.db
        .insert(schema.backupRun)
        .values({
          organizationId: state.organizationId,
          trigger: 'schedule',
          status: 'succeeded',
          startedAt,
          finishedAt: startedAt,
          destination: 'storage',
          keyPrefix: '.oci-backups/',
          dumpKey: key,
          verified: true,
        })
        .returning();
      runs.push({ id: row!.id, key });
    }
    const { backupSettings } = await import('../../services/backups/settings.js');
    const pruned = await backups.pruneBackups(await backupSettings());

    // Kept: newest on day 0 and day 1 (daily), newest of the week (day 0 again).
    // Pruned: the older one on day 1, day 3 and day 10.
    expect(pruned).toBe(3);
    const rows = await pool.db.select().from(schema.backupRun);
    const prunedIds = rows
      .filter((row) => row.prunedAt)
      .map((row) => row.id)
      .sort();
    expect(prunedIds).toEqual([runs[2]!.id, runs[3]!.id, runs[4]!.id].sort());
    for (const [index, run] of runs.entries())
      expect(await s3.exists(run.key), `run ${index}`).toBe(index < 2);
    for (const run of runs.slice(0, 2)) await s3.delete(run.key);
  });

  it('records a failure without leaking the database password', async () => {
    state.settings.set('backups', { destination: 'storage' });
    const wrong = `Wrong-Pass-${randomUUID()}`;
    const url = new URL(live.connectionString);
    url.password = wrong;
    await expect(
      backups.performBackup({ trigger: 'schedule', databaseUrl: url.toString() }),
    ).rejects.toThrow(/pg_dump failed/);

    const [run] = await pool.db
      .select()
      .from(schema.backupRun)
      .where(eq(schema.backupRun.status, 'failed'))
      .orderBy(sql`${schema.backupRun.startedAt} desc`)
      .limit(1);
    expect(run!.errorMessage).toMatch(/pg_dump failed/);
    expect(run!.errorMessage).not.toContain(wrong);
    const all = JSON.stringify([state.logs, spawned, run]);
    expect(all).not.toContain(wrong);
    expect(all).not.toContain(password);

    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, run!.id));
    expect(audit!.metadata).toMatchObject({ status: 'failed' });

    // A destination that cannot be reached is a recorded failure too.
    state.settings.set('storage', { ...(await storageSettings()), driver: 'local' });
    await expect(backups.performBackup({ trigger: 'schedule' })).rejects.toThrow(/local disk/);
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
