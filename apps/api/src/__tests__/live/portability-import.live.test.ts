import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '@oci/db';
import { strToU8, zipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * ChatGPT and Claude imports through the real upload route, job processing,
 * PostgreSQL and local storage. Fixtures are small synthetic exports built
 * here, shaped after the documented quirks: branches, hidden nodes, null
 * parts, split files, content blocks and parent-linked message trees.
 */
const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-import-'));

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  runJobNow: null as unknown as ReturnType<typeof vi.fn<(name: string) => Promise<number>>>,
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  consumeRateLimit: async () => ({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 1 }),
}));
vi.mock('../../services/jobs/index.js', () => ({
  runJobNow: (name: string) => state.runJobNow(name),
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'storage'
      ? {
          driver: 'local',
          maxFileBytes: 10 * 1024 * 1024,
          maxFilesPerMessage: 10,
          allowedMimeTypes: ['text/plain'],
          s3: {
            bucket: '',
            region: 'us-east-1',
            endpoint: null,
            accessKeyId: '',
            encryptedSecretAccessKey: null,
            forcePathStyle: false,
          },
        }
      : {},
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      STORAGE_LOCAL_PATH: storageRoot,
      IMPORT_MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
    }),
  };
});

const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
const { processPendingImports } = await import('../../services/portability/imports.js');
const { DEFAULT_READER_LIMITS } = await import('../../services/portability/import-reader.js');
type AppBindings = import('../../middleware/context.js').AppBindings;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(
  id: string,
  parent: string | null,
  children: string[],
  message: Record<string, unknown> | null,
) {
  return { id, parent, children, message };
}

function chatgptMessage(
  role: string,
  content: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    author: { role, name: null },
    create_time: 1736209400 + Math.floor(Math.random() * 100),
    content,
    status: 'finished_successfully',
    recipient: 'all',
    metadata: {},
    ...extra,
  };
}

/** Branches, a regenerated-away reply, hidden and tool nodes, null parts and split replies. */
const chatgptBranching = {
  id: 'gpt-branching',
  conversation_id: 'gpt-branching',
  title: 'Planning a garden',
  create_time: 1736209400.12,
  update_time: 1736209800.5,
  current_node: 'a2b',
  mapping: {
    root: node('root', null, ['sys'], null),
    sys: node(
      'sys',
      'root',
      ['u1'],
      chatgptMessage('system', { content_type: 'text', parts: ['You are ChatGPT'] }),
    ),
    u1: node(
      'u1',
      'sys',
      ['a1-old', 'a1'],
      chatgptMessage(
        'user',
        { content_type: 'text', parts: ['What should I plant?'] },
        {
          create_time: 1736209410,
        },
      ),
    ),
    'a1-old': node(
      'a1-old',
      'u1',
      [],
      chatgptMessage('assistant', { content_type: 'text', parts: ['Regenerated-away answer'] }),
    ),
    a1: node(
      'a1',
      'u1',
      ['a1-text'],
      chatgptMessage('assistant', {
        content_type: 'thoughts',
        thoughts: [{ summary: 'Considering', content: 'Weighing the climate', finished: true }],
      }),
    ),
    'a1-text': node(
      'a1-text',
      'a1',
      ['ctx'],
      chatgptMessage(
        'assistant',
        { content_type: 'text', parts: ['Plant tomatoes.'] },
        { metadata: { model_slug: 'gpt-4o' } },
      ),
    ),
    ctx: node(
      'ctx',
      'a1-text',
      ['hidden'],
      chatgptMessage('user', { content_type: 'user_editable_context', user_profile: 'secret' }),
    ),
    hidden: node(
      'hidden',
      'ctx',
      ['tool-call'],
      chatgptMessage(
        'user',
        { content_type: 'text', parts: ['Hidden instruction'] },
        { metadata: { is_visually_hidden_from_conversation: true } },
      ),
    ),
    'tool-call': node(
      'tool-call',
      'hidden',
      ['tool-out'],
      chatgptMessage(
        'assistant',
        { content_type: 'code', language: 'python', text: 'print("internal")' },
        { recipient: 'python' },
      ),
    ),
    'tool-out': node(
      'tool-out',
      'tool-call',
      ['u2'],
      chatgptMessage('tool', { content_type: 'execution_output', text: 'internal' }),
    ),
    u2: node(
      'u2',
      'tool-out',
      ['a2'],
      chatgptMessage(
        'user',
        {
          content_type: 'multimodal_text',
          parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc' },
            'What about this bed?',
          ],
        },
        { metadata: { attachments: [{ id: 'file-abc', name: 'bed.png' }] } },
      ),
    ),
    a2: node(
      'a2',
      'u2',
      ['mystery'],
      chatgptMessage('assistant', { content_type: 'text', parts: null }),
    ),
    mystery: node(
      'mystery',
      'a2',
      ['a2b'],
      chatgptMessage('assistant', { content_type: 'hologram', data: 1 }),
    ),
    a2b: node(
      'a2b',
      'mystery',
      [],
      chatgptMessage('assistant', { content_type: 'text', parts: ['It gets full sun.'] }),
    ),
  },
};

const chatgptSimple = {
  id: 'gpt-simple',
  title: null,
  create_time: 1736300000,
  update_time: 1736300100,
  current_node: 'b',
  mapping: {
    a: node('a', null, ['b'], chatgptMessage('user', { content_type: 'text', parts: ['Hello'] })),
    b: node('b', 'a', [], chatgptMessage('assistant', { content_type: 'text', parts: ['Hi!'] })),
  },
};

const claudeV1 = {
  uuid: 'claude-v1',
  name: 'Recipe ideas',
  summary: '',
  created_at: '2026-02-14T10:04:22.000Z',
  updated_at: '2026-02-14T10:09:00.000Z',
  account: { uuid: 'acct' },
  chat_messages: [
    {
      uuid: 'c1',
      sender: 'human',
      text: 'Suggest a soup',
      created_at: '2026-02-14T10:04:22.000Z',
      attachments: [{ file_name: 'pantry.pdf', extracted_content: 'beans' }],
      files: [],
    },
    {
      uuid: 'c2',
      sender: 'assistant',
      text: 'Try minestrone.',
      created_at: '2026-02-14T10:05:00.000Z',
    },
  ],
};

const ROOT = '00000000-0000-4000-8000-000000000000';
const claudeV2 = {
  uuid: 'claude-v2',
  name: '',
  created_at: '2026-03-01T09:00:00.000Z',
  updated_at: '2026-03-01T09:30:00.000Z',
  model: 'claude-sonnet-4-5',
  current_leaf_message_uuid: 'm5',
  chat_messages: [
    {
      uuid: 'm1',
      parent_message_uuid: ROOT,
      sender: 'human',
      text: 'Explain tides',
      content: [{ type: 'text', text: 'Explain tides' }],
      created_at: '2026-03-01T09:00:00.000Z',
    },
    {
      uuid: 'm2',
      parent_message_uuid: 'm1',
      sender: 'assistant',
      text: 'Abandoned branch',
      content: [{ type: 'text', text: 'Abandoned branch' }],
      created_at: '2026-03-01T09:01:00.000Z',
    },
    {
      uuid: 'm3',
      parent_message_uuid: 'm1',
      sender: 'assistant',
      text: 'The moon pulls the sea.',
      content: [
        { type: 'thinking', thinking: 'Gravity, mostly', summaries: [], cut_off: false },
        { type: 'tool_use', name: 'web_search', input: { query: 'tides' } },
        { type: 'tool_result', name: 'web_search', content: [], is_error: false },
        { type: 'text', text: 'The moon pulls the sea.', citations: [] },
        { type: 'token_budget' },
        { type: 'sparkle_block' },
      ],
      created_at: '2026-03-01T09:02:00.000Z',
    },
    {
      uuid: 'm4',
      parent_message_uuid: 'm3',
      sender: 'human',
      text: 'Thanks',
      content: [{ type: 'text', text: 'Thanks' }],
      created_at: '2026-03-01T09:03:00.000Z',
      files_v2: [{ file_name: 'chart.png', preview_url: 'https://example.invalid/signed' }],
    },
    {
      uuid: 'm5',
      parent_message_uuid: 'm4',
      sender: 'assistant',
      text: 'You are welcome.',
      content: [{ type: 'text', text: 'You are welcome.' }],
      created_at: '2026-03-01T09:04:00.000Z',
    },
  ],
};

/** ChatGPT's 2026 layout: split conversation files and a manifest. */
function chatgptZip(options: { missingListed?: boolean } = {}) {
  return Buffer.from(
    zipSync({
      'conversations-000.json': strToU8(JSON.stringify([chatgptBranching, chatgptSimple])),
      'export_manifest.json': strToU8(
        JSON.stringify({
          logical_files: {
            'conversations.json': {
              files: [
                'conversations-000.json',
                ...(options.missingListed ? ['conversations-001.json'] : []),
              ],
            },
          },
        }),
      ),
      'user.json': strToU8('{"id":"user"}'),
      'file-abc.dat': new Uint8Array([1, 2, 3]),
    }),
  );
}

// ---------------------------------------------------------------------------

function appFor(userId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'person@example.com',
      name: 'Person',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api/me', portabilityRoutes);
  return app;
}

async function upload(userId: string, body: Buffer | string, filename = 'export.zip') {
  const form = new FormData();
  form.append('file', new File([typeof body === 'string' ? body : new Uint8Array(body)], filename));
  return appFor(userId).request('/api/me/imports', { method: 'POST', body: form });
}

describe.skipIf(!available)('live Postgres: ChatGPT and Claude import', () => {
  let live: LiveDatabase;
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('portability_import');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, state.organizationId, { email: 'person@example.com' });
    otherId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });
  });

  beforeEach(async () => {
    state.runJobNow = vi.fn(async (_name: string) => 0);
    await live.db.execute(sql`delete from conversation_import`);
    await live.db.execute(sql`delete from thread`);
    await live.db.execute(sql`delete from storage_policy`);
  });

  afterAll(async () => {
    await live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function importsFor(id: string) {
    const response = await appFor(id).request('/api/me/imports');
    expect(response.status).toBe(200);
    return ((await response.json()) as { imports: Array<Record<string, unknown>> }).imports;
  }

  async function threadsFor(id: string) {
    return live.db.execute<{
      id: string;
      title: string;
      import_source: string;
      import_source_id: string;
      created_at: Date;
      updated_at: Date;
      last_message_at: Date;
    }>(sql`select * from thread where user_id = ${id} order by import_source_id`);
  }

  async function messagesOf(threadId: string) {
    return live.db.execute<{
      id: string;
      role: string;
      parts: Array<Record<string, unknown>>;
      position: number;
      status: string;
      parent_message_id: string | null;
      model_slug: string | null;
      created_at: Date;
    }>(sql`select * from message where thread_id = ${threadId} order by position`);
  }

  it('queues an upload, then imports the visible ChatGPT path on processing', async () => {
    const response = await upload(userId, chatgptZip({ missingListed: true }));
    expect(response.status).toBe(202);
    const { import: queued } = (await response.json()) as { import: Record<string, unknown> };
    expect(queued).toMatchObject({ status: 'pending', filename: 'export.zip' });
    expect(state.runJobNow).toHaveBeenCalledWith('imports.process');

    const [stored] = await live.db.execute<{ storage_key: string }>(
      sql`select storage_key from conversation_import where id = ${queued.id as string}`,
    );
    expect(existsSync(join(storageRoot, stored?.storage_key as string))).toBe(true);

    expect(await processPendingImports()).toBe(1);

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({
      status: 'completed',
      source: 'chatgpt',
      formatVersion: 'v2',
      importedCount: 2,
      skippedCount: 0,
      failedCount: 0,
      error: null,
    });
    expect(record?.unknownContentTypes).toEqual({ 'chatgpt.hologram': 1 });
    expect(String(record?.warnings)).toMatch(/incomplete/);

    // The upload is released once processed.
    expect(existsSync(join(storageRoot, stored?.storage_key as string))).toBe(false);
    const [released] = await live.db.execute<{ storage_key: string | null }>(
      sql`select storage_key from conversation_import where id = ${queued.id as string}`,
    );
    expect(released?.storage_key).toBeNull();

    const threads = await threadsFor(userId);
    expect(
      threads.map((thread) => [thread.title, thread.import_source, thread.import_source_id]),
    ).toEqual([
      ['Planning a garden', 'chatgpt', 'gpt-branching'],
      ['Imported conversation', 'chatgpt', 'gpt-simple'],
    ]);
    const garden = threads[0] as (typeof threads)[number];
    expect(new Date(garden.created_at).toISOString()).toBe('2025-01-07T00:23:20.120Z');
    expect(new Date(garden.updated_at).toISOString()).toBe('2025-01-07T00:30:00.500Z');
    expect(garden.last_message_at).not.toBeNull();

    const messages = await messagesOf(garden.id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
    expect(messages.every((message) => message.status === 'complete')).toBe(true);
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'What should I plant?' }]);
    expect(new Date(messages[0]?.created_at as Date).toISOString()).toBe(
      '2025-01-07T00:23:30.000Z',
    );
    expect(messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'Weighing the climate' },
      { type: 'text', text: 'Plant tomatoes.' },
    ]);
    expect(messages[1]?.model_slug).toBe('gpt-4o');
    expect(messages[1]?.parent_message_id).toBe(messages[0]?.id);
    expect(messages[2]?.parts).toEqual([
      { type: 'text', text: '_Attached in ChatGPT: bed.png (file not imported)_' },
      { type: 'text', text: 'What about this bed?' },
    ]);
    // The null-parts placeholder and the split reply collapse into one answer.
    expect(messages[3]?.parts).toEqual([{ type: 'text', text: 'It gets full sun.' }]);
    expect(messages[3]?.parent_message_id).toBe(messages[2]?.id);

    const everything = JSON.stringify(messages);
    for (const hidden of [
      'Regenerated-away answer',
      'You are ChatGPT',
      'Hidden instruction',
      'internal',
      'secret',
    ]) {
      expect(everything).not.toContain(hidden);
    }

    // Imported history is not generated usage.
    const [usage] = await live.db.execute<{ count: number }>(
      sql`select count(*)::int as count from usage_event where user_id = ${userId}`,
    );
    expect(usage?.count).toBe(0);

    const audits = await live.db.execute<{ metadata: { stage: string } }>(sql`
      select metadata from audit_log where action = 'user.import' and actor_user_id = ${userId}
      order by created_at
    `);
    expect(audits.map((row) => row.metadata.stage)).toEqual(['queued', 'completed']);
  });

  it('is idempotent: importing the same export again skips what is already there', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports();
    const [garden] = await threadsFor(userId);
    await live.db.execute(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${garden?.id as string}, ${userId}, 'user', '[{"type":"text","text":"Added here"}]'::jsonb, 4)
    `);

    expect((await upload(userId, chatgptZip())).status).toBe(202);
    await processPendingImports();

    const [latest] = await importsFor(userId);
    expect(latest).toMatchObject({ status: 'completed', importedCount: 0, skippedCount: 2 });
    expect(await threadsFor(userId)).toHaveLength(2);
    // Messages added after the first import are untouched.
    expect((await messagesOf(garden?.id as string)).at(-1)?.parts).toEqual([
      { type: 'text', text: 'Added here' },
    ]);
  });

  it('imports Claude text-only (v1) and content-block (v2) conversations from a bare JSON file', async () => {
    const response = await upload(
      userId,
      `\uFEFF${JSON.stringify([claudeV1, claudeV2])}\n`,
      'conversations.json',
    );
    expect(response.status).toBe(202);
    await processPendingImports();

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({
      status: 'completed',
      source: 'claude',
      formatVersion: 'v2',
      importedCount: 2,
    });
    expect(record?.unknownContentTypes).toEqual({ 'claude.sparkle_block': 1 });

    const threads = await threadsFor(userId);
    expect(threads.map((thread) => thread.title)).toEqual([
      'Recipe ideas',
      'Imported conversation',
    ]);
    const v1 = threads[0] as (typeof threads)[number];
    expect(new Date(v1.created_at).toISOString()).toBe('2026-02-14T10:04:22.000Z');
    expect((await messagesOf(v1.id)).map((message) => message.parts)).toEqual([
      [
        { type: 'text', text: '_Attached in Claude: pantry.pdf (file not imported)_' },
        { type: 'text', text: 'Suggest a soup' },
      ],
      [{ type: 'text', text: 'Try minestrone.' }],
    ]);

    const v2Messages = await messagesOf((threads[1] as (typeof threads)[number]).id);
    expect(v2Messages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'Explain tides' }],
      [
        { type: 'reasoning', text: 'Gravity, mostly' },
        { type: 'text', text: 'The moon pulls the sea.' },
      ],
      [
        { type: 'text', text: '_Attached in Claude: chart.png (file not imported)_' },
        { type: 'text', text: 'Thanks' },
      ],
      [{ type: 'text', text: 'You are welcome.' }],
    ]);
    expect(v2Messages[1]?.model_slug).toBe('claude-sonnet-4-5');
    expect(JSON.stringify(v2Messages)).not.toContain('Abandoned branch');
  });

  it('reads a Privacy Portal export that nests the conversations archive', async () => {
    const inner = zipSync({ 'conversations.json': strToU8(JSON.stringify([chatgptSimple])) });
    const outer = Buffer.from(
      zipSync({
        'User Online Activity/Conversations__2026-chatgpt-1.zip': inner,
        'User Online Activity/Ads__2026.zip': zipSync({ 'ads.json': strToU8('[]') }),
      }),
    );
    await upload(userId, outer);
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'completed', source: 'chatgpt', importedCount: 1 });
  });

  it('rejects a zip bomb by its actual decompressed output', async () => {
    const bomb = Buffer.from(
      zipSync({ 'conversations.json': strToU8(`[${' '.repeat(4 * 1024 * 1024)}]`) }, { level: 9 }),
    );
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await upload(userId, bomb);
    await processPendingImports({
      limits: { ...DEFAULT_READER_LIMITS, ratioGraceBytes: 1024 * 1024 },
    });

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed', importedCount: 0 });
    expect(record?.error).toMatch(/compressed suspiciously/);
  });

  it('caps total decompressed size', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports({
      limits: { ...DEFAULT_READER_LIMITS, maxUncompressedBytes: 1024 },
    });
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/expands to more data/);
  });

  it('rejects archives with path traversal entries', async () => {
    const evil = Buffer.from(
      zipSync({
        '../../outside.json': strToU8('[]'),
        'conversations.json': strToU8(JSON.stringify([chatgptSimple])),
      }),
    );
    await upload(userId, evil);
    await processPendingImports();

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed', importedCount: 0 });
    expect(record?.error).toMatch(/unsafe file path/);
    expect(existsSync(join(storageRoot, '..', 'outside.json'))).toBe(false);
    expect(await threadsFor(userId)).toHaveLength(0);
  });

  it('fails clearly on a file that is not an export', async () => {
    await upload(userId, 'just some notes', 'notes.txt');
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/Upload the \.zip file/);
  });

  it('resumes imports interrupted by a restart, without stealing live ones', async () => {
    const driver = new LocalStorageDriver(storageRoot);
    const body = Buffer.from(JSON.stringify([claudeV1]));
    async function seed(owner: string, status: string, updatedAt: string) {
      const id = crypto.randomUUID();
      const key = `imports/${owner}/${id}`;
      await driver.put(key, body, 'application/json');
      await live.db.execute(sql`
        insert into conversation_import (id, organization_id, user_id, status, filename, size_bytes,
                                         storage_key, attempts, updated_at)
        values (${id}, ${state.organizationId}, ${owner}, ${status}, 'conversations.json',
                ${body.byteLength}, ${key}, ${status === 'running' ? 1 : 0}, ${updatedAt}::timestamptz)
      `);
      return id;
    }

    const now = new Date();
    const abandoned = await seed(
      userId,
      'running',
      new Date(now.getTime() - 60 * 60_000).toISOString(),
    );
    const live1 = await seed(otherId, 'running', now.toISOString());
    // Queued behind the other person's genuinely running import.
    const waiting = await seed(otherId, 'pending', now.toISOString());

    expect(await processPendingImports()).toBe(1);

    const rows = await live.db.execute<{ id: string; status: string; attempts: number }>(
      sql`select id, status, attempts from conversation_import`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(abandoned)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(byId.get(live1)?.status).toBe('running');
    expect(byId.get(waiting)?.status).toBe('pending');
    expect(await threadsFor(userId)).toHaveLength(1);
  });

  it('requeues an import cut short by a lost database connection, and resumes it (v0.11)', async () => {
    // The second conversation's insert meets a failover: SQLSTATE 57P01, as
    // the server sends when a primary shuts down.
    await live.db.execute(
      sql.raw(`
      create function failover_on_second_thread() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from thread where user_id = new.user_id) then
          raise exception 'terminating connection due to administrator command'
            using errcode = 'admin_shutdown';
        end if;
        return new;
      end $$;
      create trigger failover_on_second_thread before insert on thread
        for each row execute function failover_on_second_thread();
    `),
    );
    try {
      expect((await upload(userId, chatgptZip())).status).toBe(202);
      await processPendingImports();
      // Back in the queue, not failed, and its attempt not used up.
      const [requeued] = await live.db.execute<{ status: string; attempts: number }>(
        sql`select status, attempts from conversation_import where user_id = ${userId}`,
      );
      expect(requeued).toEqual({ status: 'pending', attempts: 0 });
      expect(await threadsFor(userId)).toHaveLength(1);
    } finally {
      await live.db.execute(
        sql.raw(`drop trigger failover_on_second_thread on thread;
          drop function failover_on_second_thread();`),
      );
    }
    expect(await processPendingImports()).toBe(1);
    const [record] = await importsFor(userId);
    // The first conversation is recognised and skipped; the second imported.
    expect(record).toMatchObject({
      status: 'completed',
      importedCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });
    expect(await threadsFor(userId)).toHaveLength(2);
  });

  it('stops a long import at its next checkpoint when the worker shuts down, and resumes it (v0.11)', async () => {
    const { beginDrain, resetDrainForTests } = await import('../../lib/drain.js');
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...claudeV1,
      uuid: `claude-many-${index}`,
    }));
    expect((await upload(userId, JSON.stringify(many), 'conversations.json')).status).toBe(202);
    beginDrain('SIGTERM');
    try {
      await processPendingImports();
    } finally {
      resetDrainForTests();
    }
    // The 25 conversations before the checkpoint are stored; the rest wait.
    const [paused] = await live.db.execute<{ status: string; attempts: number }>(
      sql`select status, attempts from conversation_import where user_id = ${userId}`,
    );
    expect(paused).toEqual({ status: 'pending', attempts: 0 });
    expect(await threadsFor(userId)).toHaveLength(25);
    expect(await processPendingImports()).toBe(1);
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'completed', importedCount: 5, skippedCount: 25 });
  });

  it('gives up on an import that keeps crashing', async () => {
    const id = crypto.randomUUID();
    await live.db.execute(sql`
      insert into conversation_import (id, organization_id, user_id, status, filename, storage_key,
                                       attempts, updated_at)
      values (${id}, ${state.organizationId}, ${userId}, 'running', 'x.zip', ${`imports/${userId}/${id}`},
              3, now() - interval '1 hour')
    `);
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/stopped unexpectedly/);
  });

  it('keeps imports per person', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports();
    await upload(otherId, chatgptZip());
    await processPendingImports();

    // The same source conversation is new for someone else.
    expect(await threadsFor(otherId)).toHaveLength(2);
    expect(await threadsFor(userId)).toHaveLength(2);

    const mine = await importsFor(userId);
    const theirs = await importsFor(otherId);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);

    const response = await appFor(otherId).request(`/api/me/imports/${mine[0]?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    expect(await importsFor(userId)).toHaveLength(1);
  });

  it('allows one import at a time and lets a queued one be cancelled', async () => {
    const first = await upload(userId, chatgptZip());
    expect(first.status).toBe(202);
    const { import: queued } = (await first.json()) as { import: { id: string } };
    const [row] = await live.db.execute<{ storage_key: string }>(
      sql`select storage_key from conversation_import where id = ${queued.id}`,
    );

    const second = await upload(userId, chatgptZip());
    expect(second.status).toBe(409);

    const removed = await appFor(userId).request(`/api/me/imports/${queued.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(await importsFor(userId)).toHaveLength(0);
    expect(existsSync(join(storageRoot, row?.storage_key as string))).toBe(false);

    expect((await upload(userId, chatgptZip())).status).toBe(202);
  });

  it('refuses to remove a running import', async () => {
    await upload(userId, chatgptZip());
    const [row] = await live.db.execute<{ id: string }>(
      sql`update conversation_import set status = 'running', updated_at = now() returning id`,
    );
    const response = await appFor(userId).request(`/api/me/imports/${row?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
  });

  it('enforces the upload size limit and the storage allowance', async () => {
    const tooBig = await upload(userId, Buffer.alloc(3 * 1024 * 1024, 1));
    expect(tooBig.status).toBe(413);

    await live.db.execute(sql`
      insert into storage_policy (organization_id, role, max_total_bytes)
      values (${state.organizationId}, 'user', 100)
    `);
    const overQuota = await upload(userId, chatgptZip());
    expect(overQuota.status).toBe(422);
    expect(await importsFor(userId)).toHaveLength(0);
  });
});
