import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';
import { ensureBucket, liveS3Config } from './live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  seedOrganization,
  seedUser,
} from './live-postgres.js';

/**
 * Shared setup for the live automated backup suites (backups-*.live.test.ts):
 * real PostgreSQL, the real pg_dump and pg_restore, an S3-compatible server as
 * both attachment storage and backup destination, and the real admin routes.
 *
 * Each test file declares its own `vi.mock` block and hoisted `state` and
 * `spawned`, and calls `useBackupsSuite(state, spawned, pgBinDir)` inside its
 * top-level `describe`.
 */
export interface BackupsState {
  db: unknown;
  organizationId: string;
  settings: Map<string, unknown>;
  env: Record<string, unknown>;
  logs: unknown[];
}

export type Spawned = Array<{ command: string; args: string[]; env: Record<string, string> }>;

export interface BackupsContext {
  live: LiveDatabase;
  pool: ReturnType<typeof createDatabase>;
  admin: string;
  auditor: string;
  app: Hono<AppBindings>;
  backups: typeof import('../src/services/backups/run.js');
  s3: import('../src/services/storage/s3-driver.js').S3StorageDriver;
  password: string;
  tmp: string;
}

export const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/**
 * Registers the suite's hooks (a live database with three attachments per file,
 * settings, logs and spawned programs reset before each test) and returns the
 * helpers the tests use. Call inside the top-level describe.
 */
export function useBackupsSuite(state: BackupsState, spawned: Spawned, pgBinDir: string | null) {
  const ctx = {} as BackupsContext;
  const separateBucket = `oci-test-backups-${randomUUID().slice(0, 8)}`;
  const attachmentKeys: string[] = [];

  async function storageSettings() {
    const { encryptSecret } = await import('../src/lib/crypto.js');
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
    ctx.live = await createLiveDatabase('backups');
    ctx.pool = createDatabase(ctx.live.connectionString, { max: 6 });
    const { pool } = ctx;
    state.db = pool.db;
    ctx.password = decodeURIComponent(new URL(ctx.live.connectionString).password);
    state.env = { DATABASE_URL: ctx.live.connectionString, BACKUP_PG_BIN_DIR: pgBinDir };
    state.organizationId = await seedOrganization(pool.db);
    const admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    ctx.admin = admin;
    ctx.auditor = await seedUser(pool.db, state.organizationId, { role: 'auditor' });
    await ensureBucket(separateBucket);
    ctx.tmp = await mkdtemp(join(tmpdir(), 'oci-backup-test-'));

    ctx.backups = await import('../src/services/backups/run.js');
    const { S3StorageDriver } = await import('../src/services/storage/s3-driver.js');
    const s3 = new S3StorageDriver(liveS3Config);
    ctx.s3 = s3;

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

    const { adminRoutes } = await import('../src/routes/admin/index.js');
    const { errorHandler } = await import('../src/middleware/error-handler.js');
    const app = new Hono<AppBindings>();
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
    ctx.app = app;
  });

  beforeEach(async () => {
    state.settings.clear();
    state.settings.set('storage', await storageSettings());
    state.logs.length = 0;
    spawned.length = 0;
  });

  afterAll(async () => {
    for (const key of attachmentKeys) await ctx.s3?.delete(key).catch(() => {});
    if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
    await ctx.pool?.sql.end({ timeout: 1 });
    await ctx.live?.destroy();
  });

  function call(
    method: string,
    path: string,
    { user = ctx.admin, body }: { user?: string; body?: unknown } = {},
  ) {
    return ctx.app.request(path, {
      method,
      headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function download(bucket: string, key: string): Promise<Buffer> {
    const { S3StorageDriver } = await import('../src/services/storage/s3-driver.js');
    return new S3StorageDriver({ ...liveS3Config, bucket }).get(key);
  }

  return { ctx, separateBucket, attachmentKeys, storageSettings, call, download };
}
