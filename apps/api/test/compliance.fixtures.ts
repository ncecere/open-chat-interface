import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
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
 * Shared setup for the live compliance export and legal hold suites
 * (compliance-*.live.test.ts): real PostgreSQL, MinIO as the destination and
 * the real admin routes.
 *
 * Each test file declares its own `vi.mock` block and hoisted `state`, and
 * calls `useComplianceSuite(state)` inside its top-level `describe`.
 */
export interface ComplianceState {
  db: unknown;
  organizationId: string;
  settings: Map<string, unknown>;
  env: Record<string, unknown>;
}

export type ExportModule = typeof import('../src/services/compliance/export.js');
export type Line = Record<string, unknown> & { seq: number; id: string };

export interface ComplianceContext {
  live: LiveDatabase;
  pool: ReturnType<typeof createDatabase>;
  admin: string;
  auditor: string;
  app: Hono<AppBindings>;
  exporter: ExportModule;
  S3: typeof import('../src/services/storage/s3-driver.js').S3StorageDriver;
  encrypt: (value: string) => string;
}

export const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/**
 * Registers the suite's hooks (a live database per file, settings reset before
 * each test, test buckets emptied afterwards) and returns the helpers the tests
 * use. Call inside the top-level describe.
 */
export function useComplianceSuite(state: ComplianceState) {
  const ctx = {} as ComplianceContext;
  const buckets: string[] = [];

  async function storageSettings() {
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
        encryptedSecretAccessKey: ctx.encrypt(liveS3Config.secretAccessKey),
        forcePathStyle: true,
      },
    };
  }

  /** A fresh, empty bucket, so listing it shows exactly what the export wrote. */
  async function separateTarget() {
    const bucket = `oci-test-compliance-${randomUUID().slice(0, 8)}`;
    await ensureBucket(bucket);
    buckets.push(bucket);
    return {
      bucket,
      settings: {
        destination: 'separate',
        prefix: 'records/oci/',
        s3: {
          bucket,
          region: 'us-east-1',
          endpoint: liveS3Config.endpoint,
          accessKeyId: liveS3Config.accessKeyId,
          encryptedSecretAccessKey: ctx.encrypt(liveS3Config.secretAccessKey),
          forcePathStyle: true,
        },
      },
    };
  }

  const driverFor = (bucket: string) => new ctx.S3({ ...liveS3Config, bucket });

  async function listKeys(bucket: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await driverFor(bucket).list({ cursor });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.cursor;
    } while (cursor);
    return keys.sort();
  }

  async function readLines(bucket: string, key: string): Promise<Line[]> {
    const body = (await driverFor(bucket).get(key)).toString('utf8');
    return body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line);
  }

  async function auditSeqs(): Promise<number[]> {
    const rows = await ctx.pool.db
      .select({ seq: schema.auditLog.seq })
      .from(schema.auditLog)
      .orderBy(schema.auditLog.seq);
    return rows.map((row) => Number(row.seq));
  }

  async function cursor(stream: 'audit' | 'messages'): Promise<number | null> {
    const [row] = await ctx.pool.db
      .select()
      .from(schema.complianceExportCursor)
      .where(eq(schema.complianceExportCursor.stream, stream));
    return row ? Number(row.lastSeq) : null;
  }

  async function audit(action: string, at?: Date, actor: string | null = ctx.admin) {
    await ctx.pool.db.execute(sql`
      insert into audit_log (organization_id, actor_user_id, actor_email, action, target_type, target_id, metadata, created_at)
      values (${state.organizationId}, ${actor}, 'admin@example.test', ${action}, 'thing', ${randomUUID()},
        ${JSON.stringify({ note: action })}::jsonb, ${(at ?? new Date()).toISOString()}::timestamptz)
    `);
  }

  async function thread(
    userId: string,
    fields: { temporary?: boolean; expiresAt?: Date; deletedAt?: Date; lastMessageAt?: Date } = {},
  ): Promise<string> {
    const [row] = await ctx.pool.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title, temporary, expires_at, deleted_at, deleted_reason, last_message_at, created_at)
      values (${state.organizationId}, ${userId}, 'Quarterly plan', ${fields.temporary ?? false},
        ${fields.expiresAt?.toISOString() ?? null}::timestamptz, ${fields.deletedAt?.toISOString() ?? null}::timestamptz,
        ${fields.deletedAt ? 'user' : null}, ${fields.lastMessageAt?.toISOString() ?? null}::timestamptz,
        ${(fields.lastMessageAt ?? new Date()).toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  async function message(
    threadId: string,
    userId: string,
    parts: unknown[],
    fields: { role?: string; status?: string } = {},
  ): Promise<string> {
    const [row] = await ctx.pool.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, status)
      values (${threadId}, ${userId}, ${fields.role ?? 'user'}, ${JSON.stringify(parts)}::jsonb, ${fields.status ?? 'complete'})
      returning id`);
    return row!.id;
  }

  async function exists(table: 'thread' | 'user', id: string): Promise<boolean> {
    const rows = await ctx.pool.db.execute(
      sql`select 1 from ${sql.identifier(table)} where id = ${id}`,
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    ctx.live = await createLiveDatabase('compliance');
    ctx.pool = createDatabase(ctx.live.connectionString, { max: 6 });
    const { pool } = ctx;
    state.db = pool.db;
    state.env = { DATABASE_URL: ctx.live.connectionString };
    state.organizationId = await seedOrganization(pool.db);
    const admin = await seedUser(pool.db, state.organizationId, {
      role: 'admin',
      email: 'admin@example.test',
    });
    ctx.admin = admin;
    ctx.auditor = await seedUser(pool.db, state.organizationId, {
      role: 'auditor',
      email: 'auditor@example.test',
    });
    ({ encryptSecret: ctx.encrypt } = await import('../src/lib/crypto.js'));
    ({ S3StorageDriver: ctx.S3 } = await import('../src/services/storage/s3-driver.js'));
    ctx.exporter = await import('../src/services/compliance/export.js');

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
    await ctx.pool.db.delete(schema.complianceExportRun);
    await ctx.pool.db.delete(schema.complianceExportCursor);
  });

  afterAll(async () => {
    for (const bucket of buckets)
      for (const key of await listKeys(bucket).catch(() => []))
        await driverFor(bucket)
          .delete(key)
          .catch(() => {});
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

  return {
    ctx,
    separateTarget,
    driverFor,
    listKeys,
    readLines,
    auditSeqs,
    cursor,
    audit,
    thread,
    message,
    exists,
    call,
  };
}
