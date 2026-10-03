import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createDatabase, eq, runMigrations, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBucket, liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Compliance export and legal hold end to end: real PostgreSQL (the
 * migration's sequence, trigger and SHARE-lock watermark), MinIO as the
 * destination, the real admin routes and the real retention jobs.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
  env: {} as Record<string, unknown>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// The job lock opens its own connection from DATABASE_URL.
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
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

const available = (await livePostgresAvailable()) && (await liveS3Available());

type ExportModule = typeof import('../../services/compliance/export.js');
type Line = Record<string, unknown> & { seq: number; id: string };

describe.skipIf(!available)('live: compliance export and legal hold', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let auditor: string;
  let app: Hono<AppBindings>;
  let exporter: ExportModule;
  let S3: typeof import('../../services/storage/s3-driver.js').S3StorageDriver;
  let encrypt: (value: string) => string;
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
        encryptedSecretAccessKey: encrypt(liveS3Config.secretAccessKey),
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
          encryptedSecretAccessKey: encrypt(liveS3Config.secretAccessKey),
          forcePathStyle: true,
        },
      },
    };
  }

  const driverFor = (bucket: string) => new S3({ ...liveS3Config, bucket });

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
    const rows = await pool.db
      .select({ seq: schema.auditLog.seq })
      .from(schema.auditLog)
      .orderBy(schema.auditLog.seq);
    return rows.map((row) => Number(row.seq));
  }

  async function cursor(stream: 'audit' | 'messages'): Promise<number | null> {
    const [row] = await pool.db
      .select()
      .from(schema.complianceExportCursor)
      .where(eq(schema.complianceExportCursor.stream, stream));
    return row ? Number(row.lastSeq) : null;
  }

  async function audit(action: string, at?: Date, actor: string | null = admin) {
    await pool.db.execute(sql`
      insert into audit_log (organization_id, actor_user_id, actor_email, action, target_type, target_id, metadata, created_at)
      values (${state.organizationId}, ${actor}, 'admin@example.test', ${action}, 'thing', ${randomUUID()},
        ${JSON.stringify({ note: action })}::jsonb, ${(at ?? new Date()).toISOString()}::timestamptz)
    `);
  }

  async function thread(
    userId: string,
    fields: { temporary?: boolean; expiresAt?: Date; deletedAt?: Date; lastMessageAt?: Date } = {},
  ): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
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
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, status)
      values (${threadId}, ${userId}, ${fields.role ?? 'user'}, ${JSON.stringify(parts)}::jsonb, ${fields.status ?? 'complete'})
      returning id`);
    return row!.id;
  }

  async function exists(table: 'thread' | 'user', id: string): Promise<boolean> {
    const rows = await pool.db.execute(
      sql`select 1 from ${sql.identifier(table)} where id = ${id}`,
    );
    return rows.length > 0;
  }

  const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

  beforeAll(async () => {
    live = await createLiveDatabase('compliance');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.env = { DATABASE_URL: live.connectionString };
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, {
      role: 'admin',
      email: 'admin@example.test',
    });
    auditor = await seedUser(pool.db, state.organizationId, {
      role: 'auditor',
      email: 'auditor@example.test',
    });
    ({ encryptSecret: encrypt } = await import('../../lib/crypto.js'));
    ({ S3StorageDriver: S3 } = await import('../../services/storage/s3-driver.js'));
    exporter = await import('../../services/compliance/export.js');

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
    await pool.db.delete(schema.complianceExportRun);
    await pool.db.delete(schema.complianceExportCursor);
  });

  afterAll(async () => {
    for (const bucket of buckets)
      for (const key of await listKeys(bucket).catch(() => []))
        await driverFor(bucket)
          .delete(key)
          .catch(() => {});
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

  it('numbers existing audit entries in order and every new one after them', async () => {
    const seqs = await auditSeqs();
    expect(new Set(seqs).size).toBe(seqs.length);
    await audit('numbering.check');
    const after = await auditSeqs();
    expect(after.at(-1)).toBeGreaterThan(seqs.at(-1) ?? 0);
    const defaults = await pool.db.execute<{ column_default: string; is_nullable: string }>(sql`
      select column_default, is_nullable from information_schema.columns
      where table_name = 'audit_log' and column_name = 'seq'`);
    expect(defaults[0]).toMatchObject({ is_nullable: 'NO' });
    expect(defaults[0]!.column_default).toContain('audit_log_seq_seq');
  });

  it('writes audit events as JSON Lines with a verified manifest, without conversation content', async () => {
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    const chat = await thread(admin);
    await message(chat, admin, [{ type: 'text', text: 'Confidential merger terms' }]);
    await audit('export.first');
    await audit('export.second');
    const all = await auditSeqs();

    const run = await exporter.performComplianceExport({
      trigger: 'manual',
      actor: { id: admin, email: 'admin@example.test' },
    });
    expect(run).toMatchObject({ status: 'succeeded', verified: true, includeContent: false });
    expect(run.messagesKey).toBeNull();
    expect(run.auditKey).toMatch(/^records\/oci\/\d{4}\/\d{2}\/\d{2}\/.+\/audit\.jsonl$/);

    const lines = await readLines(target.bucket, run.auditKey!);
    // The first export holds the whole audit history, in order.
    expect(lines.map((line) => line.seq)).toEqual(all);
    expect(lines.find((line) => line.action === 'export.second')).toMatchObject({
      actorUserId: admin,
      actorEmail: 'admin@example.test',
      targetType: 'thing',
      metadata: { note: 'export.second' },
      createdAt: expect.any(String),
    });
    expect(run.auditCount).toBe(all.length);
    expect(Number(run.auditThroughSeq)).toBe(all.at(-1));

    const body = await driverFor(target.bucket).get(run.auditKey!);
    const manifest = JSON.parse(
      (await driverFor(target.bucket).get(run.manifestKey!)).toString('utf8'),
    );
    expect(manifest).toMatchObject({
      format: 'oci-compliance/1',
      runId: run.id,
      contentIncluded: false,
      streams: {
        audit: {
          key: run.auditKey,
          afterSeq: 0,
          throughSeq: all.at(-1),
          count: all.length,
          firstSeq: all[0],
          lastSeq: all.at(-1),
          firstId: lines[0]!.id,
          lastId: lines.at(-1)!.id,
          bytes: body.byteLength,
          sha256: sha(body),
        },
        messages: null,
      },
    });
    expect(run.manifestSha256).toBe(sha(await driverFor(target.bucket).get(run.manifestKey!)));
    // Nothing about conversations: no messages object and no content anywhere.
    const keys = await listKeys(target.bucket);
    expect(keys.some((key) => key.endsWith('messages.jsonl'))).toBe(false);
    for (const key of keys)
      expect((await driverFor(target.bucket).get(key)).toString('utf8')).not.toContain(
        'Confidential merger terms',
      );
    expect(await cursor('audit')).toBe(all.at(-1));
    expect(await cursor('messages')).toBeNull();

    // A manual run is audited.
    const [entry] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, run.id));
    expect(entry).toMatchObject({ action: 'compliance.export.run', actorUserId: admin });
  });

  it('continues from the cursor across runs and restarts: no gaps, no duplicates, ties included', async () => {
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    const tie = new Date('2026-09-30T12:00:00.000Z');

    // Same timestamp on both sides of each run boundary.
    await audit('tie.a', tie);
    await audit('tie.b', tie);
    const first = await exporter.performComplianceExport({ trigger: 'schedule' });
    await audit('tie.c', tie);
    await audit('tie.d', tie);
    await audit('later', new Date(tie.getTime() - 60_000));

    // A run that died after uploading but before moving the cursor (a restart):
    // its objects are on the destination and its row still says running.
    const after = (await cursor('audit'))!;
    const crashedId = randomUUID();
    const crashedKey = `records/oci/crashed-${crashedId}/audit.jsonl`;
    const crashedManifest = `records/oci/crashed-${crashedId}/manifest.json`;
    await driverFor(target.bucket).put(
      crashedKey,
      Buffer.from(`${JSON.stringify({ seq: after + 1, id: 'dup' })}\n`),
      'application/x-ndjson',
    );
    await driverFor(target.bucket).put(crashedManifest, Buffer.from('{}'), 'application/json');
    await pool.db.insert(schema.complianceExportRun).values({
      id: crashedId,
      organizationId: state.organizationId,
      trigger: 'schedule',
      status: 'running',
      destination: 'separate',
      keyPrefix: 'records/oci/',
      auditKey: crashedKey,
      manifestKey: crashedManifest,
    });

    // A restart: the module is loaded afresh; everything it needs is in the database.
    vi.resetModules();
    const restarted: ExportModule = await import('../../services/compliance/export.js');
    const second = await restarted.performComplianceExport({ trigger: 'schedule' });
    const third = await restarted.performComplianceExport({ trigger: 'schedule' });

    const [crashed] = await pool.db
      .select()
      .from(schema.complianceExportRun)
      .where(eq(schema.complianceExportRun.id, crashedId));
    expect(crashed).toMatchObject({ status: 'failed', cleanupPending: false });
    expect(crashed!.errorMessage).toMatch(/Interrupted/);
    const keys = await listKeys(target.bucket);
    expect(keys).not.toContain(crashedKey);
    expect(keys).not.toContain(crashedManifest);

    // Nothing new for the third run: no objects, the cursor stays.
    expect(third).toMatchObject({ status: 'succeeded', auditCount: 0, auditKey: null });
    expect(third.manifestKey).toBeNull();

    // Every audit entry appears in exactly one object, and the ranges chain.
    const exported: number[] = [];
    for (const key of keys.filter((key) => key.endsWith('audit.jsonl')))
      exported.push(...(await readLines(target.bucket, key)).map((line) => line.seq));
    expect(exported.sort((a, b) => a - b)).toEqual(await auditSeqs());
    expect(Number(second.auditAfterSeq)).toBe(Number(first.auditThroughSeq));
    expect(Number(third.auditAfterSeq)).toBe(Number(second.auditThroughSeq));
    const secondLines = await readLines(target.bucket, second.auditKey!);
    expect(secondLines.map((line) => line.action)).toEqual(
      expect.arrayContaining(['tie.c', 'tie.d', 'later']),
    );
    expect(secondLines.map((line) => line.action)).not.toContain('tie.b');
  });

  it('waits for an uncommitted audit entry instead of passing it, and leaves the cursor alone', async () => {
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    await exporter.performComplianceExport({ trigger: 'schedule' });
    const before = (await cursor('audit'))!;

    // Another session draws a sequence number and has not committed yet...
    const other = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    try {
      await other.begin(async (tx) => {
        await tx`insert into audit_log (organization_id, action) values (${state.organizationId}, 'slow.writer')`;
        // ...while a later entry commits.
        await audit('fast.writer');

        await expect(
          exporter.performComplianceExport({
            trigger: 'schedule',
            lockTimeoutMs: 50,
            lockAttempts: 1,
          }),
        ).rejects.toThrow(/stayed busy/);
        expect(await cursor('audit')).toBe(before);
        const [failed] = await pool.db
          .select()
          .from(schema.complianceExportRun)
          .where(eq(schema.complianceExportRun.status, 'failed'));
        expect(failed!.errorMessage).toMatch(/stayed busy/);
      });
    } finally {
      await other.end({ timeout: 1 });
    }

    const run = await exporter.performComplianceExport({ trigger: 'schedule' });
    const lines = (await readLines(target.bucket, run.auditKey!)).filter(
      (line) => line.action !== 'compliance.export.run',
    );
    expect(lines.map((line) => line.action)).toEqual(['slow.writer', 'fast.writer']);
    expect(lines[0]!.seq).toBeLessThan(lines[1]!.seq);
  });

  it('exports conversation content only when turned on, from then on, with summaries but no bytes', async () => {
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: false, ...target.settings });
    const chat = await thread(admin);
    await message(chat, admin, [{ type: 'text', text: 'Written before content export' }]);

    // Turned on through the settings page: content starts from now.
    const response = await call('PATCH', '/api/admin/compliance/settings', {
      body: { enabled: true, includeContent: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await cursor('messages')).toBeGreaterThan(0);

    const userMessage = await message(chat, admin, [
      { type: 'text', text: 'Please summarise the contract.' },
      {
        type: 'data-attachment',
        data: {
          id: 'att-1',
          filename: 'contract.pdf',
          mimeType: 'application/pdf',
          url: '/api/attachments/att-1/content',
        },
      },
      {
        type: 'file',
        filename: 'inline.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,QUJD',
      },
    ]);
    const reply = await message(
      chat,
      admin,
      [
        { type: 'reasoning', text: 'Private chain of thought' },
        {
          type: 'tool-web_search',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { query: 'contract law' },
          output: { results: [{ title: 'Raw page body', url: 'https://example.test' }] },
        },
        { type: 'source-url', url: 'https://example.test/source' },
        { type: 'text', text: 'Here is the summary.' },
      ],
      { role: 'assistant' },
    );
    const streaming = await message(chat, admin, [{ type: 'text', text: 'Half a rep' }], {
      role: 'assistant',
      status: 'streaming',
    });

    const run = await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(run).toMatchObject({ status: 'succeeded', includeContent: true });
    const lines = await readLines(target.bucket, run.messagesKey!);
    expect(lines.map((line) => line.id)).toEqual([userMessage, reply]);
    expect(lines[0]).toMatchObject({
      threadId: chat,
      userId: admin,
      userEmail: 'admin@example.test',
      role: 'user',
      text: 'Please summarise the contract.',
      files: [
        { attachmentId: 'att-1', filename: 'contract.pdf', mediaType: 'application/pdf' },
        { attachmentId: null, filename: 'inline.png', mediaType: 'image/png' },
      ],
      thread: { title: 'Quarterly plan', temporary: false },
    });
    expect(lines[1]).toMatchObject({
      role: 'assistant',
      text: 'Here is the summary.',
      toolSteps: [{ toolCallId: 'call-1', tool: 'web_search', state: 'done' }],
      sources: ['https://example.test/source'],
    });
    const raw = (await driverFor(target.bucket).get(run.messagesKey!)).toString('utf8');
    for (const secret of [
      'Written before content export',
      'Private chain of thought',
      'Raw page body',
      'QUJD',
      '/api/attachments/',
      'Half a rep',
    ])
      expect(raw).not.toContain(secret);
    const manifest = JSON.parse(
      (await driverFor(target.bucket).get(run.manifestKey!)).toString('utf8'),
    );
    expect(manifest.streams.messages).toMatchObject({ count: 2, key: run.messagesKey });

    // The streamed reply is exported once it finishes, and a change exports the message again.
    await pool.db.execute(
      sql`update message set status = 'complete', parts = ${JSON.stringify([{ type: 'text', text: 'Half a reply, finished' }])}::jsonb where id = ${streaming}`,
    );
    await pool.db.execute(sql`update message set superseded_at = now() where id = ${reply}`);
    // Columns the export does not show do not count as a change.
    await pool.db.execute(sql`update message set tokens_out = 12 where id = ${userMessage}`);
    const next = await exporter.performComplianceExport({ trigger: 'schedule' });
    const changed = await readLines(target.bucket, next.messagesKey!);
    expect(changed.map((line) => line.id)).toEqual([streaming, reply]);
    expect(changed[0]).toMatchObject({ status: 'complete', text: 'Half a reply, finished' });
    expect(changed[1]!.supersededAt).toEqual(expect.any(String));
    expect(Number(next.messagesAfterSeq)).toBe(Number(run.messagesThroughSeq));
  });

  it('leaves the cursor unchanged and removes its objects when a run fails', async () => {
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    await exporter.performComplianceExport({ trigger: 'schedule' });
    const before = await cursor('audit');
    await audit('after.first');

    // The stored object reads back differently: verification fails.
    const spy = vi
      .spyOn(S3.prototype, 'getStream')
      .mockResolvedValueOnce(Readable.from([Buffer.from('tampered\n')]));
    await expect(exporter.performComplianceExport({ trigger: 'schedule' })).rejects.toThrow(
      /Verification failed/,
    );
    spy.mockRestore();
    expect(await cursor('audit')).toBe(before);
    const [failed] = await pool.db
      .select()
      .from(schema.complianceExportRun)
      .where(eq(schema.complianceExportRun.status, 'failed'));
    expect(failed).toMatchObject({ cleanupPending: false, verified: false });
    for (const key of [failed!.auditKey, failed!.manifestKey])
      expect(await driverFor(target.bucket).exists(key!), key!).toBe(false);
    const [entry] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, failed!.id));
    expect(entry).toMatchObject({ action: 'compliance.export.run' });
    expect(entry!.metadata).toMatchObject({ status: 'failed' });

    // An unreachable destination fails the same way.
    state.settings.set('compliance', {
      enabled: true,
      ...target.settings,
      s3: { ...target.settings.s3, bucket: `missing-${randomUUID().slice(0, 8)}` },
    });
    await expect(exporter.performComplianceExport({ trigger: 'schedule' })).rejects.toThrow(
      /Export failed/,
    );
    expect(await cursor('audit')).toBe(before);

    // The next good run picks up exactly where the last success left off.
    state.settings.set('compliance', { enabled: true, ...target.settings });
    const run = await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(Number(run.auditAfterSeq)).toBe(before);
    expect((await readLines(target.bucket, run.auditKey!)).map((line) => line.action)).toContain(
      'after.first',
    );
  });

  it('uses the attachment bucket under .oci-compliance/, runs on schedule, and prunes when asked', async () => {
    state.settings.set('compliance', { enabled: false, destination: 'storage' });
    expect(await exporter.runScheduledComplianceExport()).toBe(0);
    state.settings.set('compliance', { enabled: true, destination: 'storage', schedule: 'hourly' });
    expect(await exporter.runScheduledComplianceExport()).toBeGreaterThan(0);
    expect(await exporter.runScheduledComplianceExport()).toBe(0);
    const [run] = await pool.db.select().from(schema.complianceExportRun);
    expect(run!.auditKey).toMatch(/^\.oci-compliance\//);
    expect(await driverFor(liveS3Config.bucket).exists(run!.auditKey!)).toBe(true);

    // Kept by default; deleted after keepDays when set. The cursor is unaffected.
    const { complianceSettings } = await import('../../services/compliance/settings.js');
    const later = new Date(Date.now() + 3 * 86_400_000);
    expect(
      await exporter.pruneComplianceExports(await complianceSettings(), undefined, later),
    ).toBe(0);
    state.settings.set('compliance', { enabled: true, destination: 'storage', keepDays: 2 });
    const before = await cursor('audit');
    expect(
      await exporter.pruneComplianceExports(await complianceSettings(), undefined, later),
    ).toBe(1);
    expect(await driverFor(liveS3Config.bucket).exists(run!.auditKey!)).toBe(false);
    expect(await cursor('audit')).toBe(before);

    expect(
      exporter.complianceSlot(new Date('2026-10-02T10:45:00Z'), 'hourly', 0).toISOString(),
    ).toBe('2026-10-02T10:00:00.000Z');
    expect(
      exporter.complianceSlot(new Date('2026-10-02T01:00:00Z'), 'daily', 2).toISOString(),
    ).toBe('2026-10-01T02:00:00.000Z');
  });

  it('skips held people in retention, trash purging, temporary expiry and account deletion', async () => {
    const held = await seedUser(pool.db, state.organizationId, { email: 'held@example.test' });
    const free = await seedUser(pool.db, state.organizationId, { email: 'free@example.test' });
    state.settings.set('retention', {
      threadRetentionDays: 30,
      trashRetentionDays: 7,
      auditLogRetentionDays: 30,
      exemptPinnedThreads: false,
    });
    const old = new Date(Date.now() - 90 * 86_400_000);
    const fixtures = new Map<string, { held: string; free: string }>();
    for (const [name, fields] of [
      ['inactive', { lastMessageAt: old }],
      ['trashed', { deletedAt: old }],
      ['temporary', { temporary: true, expiresAt: old }],
    ] as const)
      fixtures.set(name, { held: await thread(held, fields), free: await thread(free, fields) });
    await audit('old.by.held', old, held);
    await audit('old.by.free', old, free);

    let response = await call('POST', '/api/admin/compliance/holds', {
      body: { email: 'HELD@example.test', reason: 'Matter 2026-17' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { hold } = (await response.json()) as { hold: { id: string } };
    response = await call('POST', '/api/admin/compliance/holds', {
      body: { userId: held, reason: 'Again' },
    });
    expect(response.status).toBe(409);

    const { applyThreadRetention, pruneAuditLog } = await import(
      '../../services/lifecycle/retention.js'
    );
    const { purgeExpiredTrash, emptyTrash } = await import('../../services/lifecycle/trash.js');
    const { purgeExpiredTemporaryThreads } = await import('../../services/threads.js');
    expect(await applyThreadRetention()).toBe(1);
    expect(await purgeExpiredTrash()).toBe(1);
    expect(await purgeExpiredTemporaryThreads()).toBe(1);
    await pruneAuditLog();

    const deletedAt = async (id: string) => {
      const [row] = await pool.db.execute<{ deleted_at: string | null }>(
        sql`select deleted_at from thread where id = ${id}`,
      );
      return row?.deleted_at ?? null;
    };
    expect(await deletedAt(fixtures.get('inactive')!.held)).toBeNull();
    expect(await deletedAt(fixtures.get('inactive')!.free)).not.toBeNull();
    expect(await exists('thread', fixtures.get('trashed')!.held)).toBe(true);
    expect(await exists('thread', fixtures.get('trashed')!.free)).toBe(false);
    expect(await exists('thread', fixtures.get('temporary')!.held)).toBe(true);
    expect(await exists('thread', fixtures.get('temporary')!.free)).toBe(false);
    const actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).toContain('old.by.held');
    expect(actions).not.toContain('old.by.free');

    // Their own permanent deletion is paused too; moving to the trash is not.
    await expect(emptyTrash(held)).rejects.toMatchObject({ status: 409 });
    // (The free person's inactive conversation, which retention just trashed.)
    expect(await emptyTrash(free)).toBe(1);

    // Marked in the users list and on the account page.
    response = await call('GET', '/api/admin/users?search=example.test&limit=200', {
      user: auditor,
    });
    const listing = (await response.json()) as {
      users: Array<{ id: string; legalHold: boolean }>;
    };
    expect(listing.users.find((user) => user.id === held)?.legalHold).toBe(true);
    expect(listing.users.find((user) => user.id === free)?.legalHold).toBe(false);
    response = await call('GET', `/api/admin/users/${held}`, { user: auditor });
    expect(await response.json()).toMatchObject({
      user: { legalHold: true },
      legalHold: { reason: 'Matter 2026-17', placedByEmail: 'admin@example.test' },
    });

    // Account deletion is refused with a clear reason, by the route and by the database.
    response = await call('DELETE', `/api/admin/users/${held}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /legal hold/,
    );
    await expect(pool.db.execute(sql`delete from "user" where id = ${held}`)).rejects.toThrow();
    expect(await exists('user', held)).toBe(true);
    response = await call('DELETE', `/api/admin/users/${free}`);
    expect(response.status).toBe(200);
    expect(await exists('user', free)).toBe(false);

    // Lifted: everything applies again.
    response = await call('POST', `/api/admin/compliance/holds/${hold.id}/lift`, {
      body: { reason: 'Matter closed' },
    });
    expect(response.status).toBe(200);
    expect(await purgeExpiredTrash()).toBe(1);
    response = await call('DELETE', `/api/admin/users/${held}`);
    expect(response.status).toBe(200);
    expect(await exists('user', held)).toBe(false);

    const entries = await pool.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} like 'compliance.hold.%'`)
      .orderBy(schema.auditLog.seq);
    expect(entries.map((entry) => entry.action)).toEqual([
      'compliance.hold.place',
      'compliance.hold.lift',
    ]);
    expect(entries[0]).toMatchObject({ actorUserId: admin, targetType: 'user', targetId: held });
    expect(entries[0]!.metadata).toMatchObject({ reason: 'Matter 2026-17' });
    expect(entries[1]!.metadata).toMatchObject({ reason: 'Matter closed' });
  });

  it('keeps unexported audit entries from retention while the export is on', async () => {
    state.settings.set('retention', { auditLogRetentionDays: 30 });
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    const old = new Date(Date.now() - 90 * 86_400_000);
    await exporter.performComplianceExport({ trigger: 'schedule' });
    await audit('old.unexported', old, null);
    const { pruneAuditLog } = await import('../../services/lifecycle/retention.js');
    await pruneAuditLog();
    let actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).toContain('old.unexported');
    await exporter.performComplianceExport({ trigger: 'schedule' });
    await pruneAuditLog();
    actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).not.toContain('old.unexported');
  });

  it('serves the page to auditors read-only and changes, tests and runs for admins', async () => {
    const target = await separateTarget();
    let response = await call('GET', '/api/admin/compliance', { user: auditor });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { enabled: false, includeContent: false, keepDays: null, schedule: 'daily' },
      cursor: { audit: 0, messages: null },
    });
    for (const [method, path, body] of [
      ['PATCH', '/api/admin/compliance/settings', { enabled: true }],
      ['POST', '/api/admin/compliance/run', undefined],
      ['POST', '/api/admin/compliance/test', undefined],
      ['POST', '/api/admin/compliance/holds', { userId: admin, reason: 'x' }],
      ['POST', '/api/admin/compliance/holds/any/lift', {}],
    ] as const) {
      response = await call(method, path, { user: auditor, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // Turning on is refused while the destination is incomplete.
    response = await call('PATCH', '/api/admin/compliance/settings', {
      body: { enabled: true, destination: 'separate', s3: { bucket: target.bucket } },
    });
    expect(response.status).toBe(422);

    response = await call('PATCH', '/api/admin/compliance/settings', {
      body: {
        enabled: true,
        schedule: 'hourly',
        destination: 'separate',
        prefix: 'via-api/',
        keepDays: 365,
        s3: {
          bucket: target.bucket,
          region: 'us-east-1',
          endpoint: liveS3Config.endpoint,
          accessKeyId: liveS3Config.accessKeyId,
          secretAccessKey: liveS3Config.secretAccessKey,
          forcePathStyle: true,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({
      settings: { enabled: true, schedule: 'hourly', keepDays: 365, s3: { hasCredential: true } },
    });
    expect(JSON.stringify(saved)).not.toContain(liveS3Config.secretAccessKey);
    const [update] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'compliance.settings.update'))
      .orderBy(sql`${schema.auditLog.seq} desc`)
      .limit(1);
    expect((update!.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['enabled', 'schedule', 's3.secretAccessKey']),
    );
    expect(JSON.stringify(update)).not.toContain(liveS3Config.secretAccessKey);

    response = await call('POST', '/api/admin/compliance/test');
    expect(await response.json()).toMatchObject({ ok: true });

    response = await call('POST', '/api/admin/compliance/run');
    expect(response.status).toBe(202);
    let finished: { status: string; auditKey: string | null } | undefined;
    for (let attempt = 0; attempt < 120 && !finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [row] = await pool.db.select().from(schema.complianceExportRun);
      if (row && row.status !== 'running') finished = row;
    }
    expect(finished?.status).toBe('succeeded');
    expect(finished?.auditKey).toMatch(/^via-api\//);

    response = await call('GET', '/api/admin/compliance', { user: auditor });
    const status = (await response.json()) as {
      runs: unknown[];
      lastSuccessAt: string;
      nextRunAt: string;
      holds: unknown[];
    };
    expect(status.runs).toHaveLength(1);
    expect(status.lastSuccessAt).toBeTruthy();
    expect(new Date(status.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    response = await call('GET', '/api/admin/compliance/holds', { user: auditor });
    expect(response.status).toBe(200);
  }, 30_000);

  it('reports on System health', async () => {
    const { complianceHealthCheck } = await import('../../services/observability/health-checks.js');
    state.settings.set('compliance', { enabled: false });
    expect(await complianceHealthCheck()).toMatchObject({ status: 'ok', detail: 'Off.' });

    const person = await seedUser(pool.db, state.organizationId);
    await pool.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: person,
      userEmail: 'person@example.test',
      reason: 'Matter',
    });
    expect((await complianceHealthCheck()).detail).toBe('Off. 1 person on legal hold.');

    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    expect(await complianceHealthCheck()).toMatchObject({ status: 'warn' });
    await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(await complianceHealthCheck()).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^Last export .+audit events only/),
    });
    expect(await complianceHealthCheck(new Date(Date.now() + 3 * 86_400_000))).toMatchObject({
      status: 'warn',
    });
    state.settings.set('compliance', {
      enabled: true,
      ...target.settings,
      s3: { ...target.settings.s3, bucket: `missing-${randomUUID().slice(0, 8)}` },
    });
    // A run with nothing new writes nothing; this one has an event to write.
    await audit('health.event');
    await expect(exporter.performComplianceExport({ trigger: 'schedule' })).rejects.toThrow();
    expect(await complianceHealthCheck()).toMatchObject({ status: 'error' });

    await pool.db.delete(schema.legalHold);
  });
});

describe.skipIf(!available)('live migration 0034: numbering existing audit entries', () => {
  let live: LiveDatabase;
  afterAll(async () => {
    await live?.destroy();
  });

  it('numbers entries written before v0.9 in time order, then continues the sequence', async () => {
    live = await createLiveDatabase('compliance_migration');
    const organizationId = await seedOrganization(live.db);
    // Back to the shape before 0034 (the sequence goes with the column it belongs to).
    await live.db.execute(sql`alter table audit_log drop column seq`);
    const journal = JSON.parse(
      readFileSync(
        new URL('../../../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === '0034_compliance');
    if (!entry) throw new Error('Migration 0034 is missing from the journal');
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where created_at >= ${entry.when}::bigint`);

    // Inserted out of time order, with a tie.
    const times = ['2026-03-01T00:00:02Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z'];
    for (const [index, at] of [...times, times[0]!].entries())
      await live.db.execute(sql`insert into audit_log (organization_id, action, created_at)
        values (${organizationId}, ${`before.${index}`}, ${at}::timestamptz)`);

    await runMigrations(live.db);
    const rows = await live.db.execute<{ seq: string; created_at: Date | string; id: string }>(
      sql`select seq, created_at, id from audit_log order by seq`,
    );
    const ordered = [...rows].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
        (a.id < b.id ? -1 : 1),
    );
    expect(rows.map((row) => row.id)).toEqual(ordered.map((row) => row.id));
    expect(rows.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4]);

    await live.db.execute(sql`insert into audit_log (organization_id, action)
      values (${organizationId}, 'after')`);
    const [latest] = await live.db.execute<{ seq: string }>(
      sql`select seq from audit_log where action = 'after'`,
    );
    expect(Number(latest!.seq)).toBe(5);
    // Applying it again changes nothing.
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where created_at >= ${entry.when}::bigint`);
    await runMigrations(live.db);
    const again = await live.db.execute<{ seq: string }>(
      sql`select seq from audit_log order by seq`,
    );
    expect(again.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4, 5]);
  });
});
