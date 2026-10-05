import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq, schema, sql } from '@oci/db';
import postgres from 'postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ComplianceContext,
  type ExportModule,
  sha,
  useComplianceSuite,
} from '../../../test/compliance.fixtures.js';
import { liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Compliance export end to end: real PostgreSQL (the migration's sequence,
 * trigger and SHARE-lock watermark), MinIO as the destination and the real
 * admin routes. The cursor, the manifest, content export, failed runs, and
 * scheduled runs and pruning.
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

describe.skipIf(!available)('live: compliance export and legal hold', () => {
  const suite = useComplianceSuite(state);
  const {
    separateTarget,
    driverFor,
    listKeys,
    readLines,
    auditSeqs,
    cursor,
    audit,
    thread,
    message,
    call,
  } = suite;
  let live: ComplianceContext['live'];
  let pool: ComplianceContext['pool'];
  let admin: ComplianceContext['admin'];
  let exporter: ComplianceContext['exporter'];
  let S3: ComplianceContext['S3'];
  beforeAll(() => {
    ({ live, pool, admin, exporter, S3 } = suite.ctx);
  });

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
});
