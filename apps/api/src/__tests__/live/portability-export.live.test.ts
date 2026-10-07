import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '@oci/db';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Full-account export through the real route, real database and real local
 * storage. The export returns everything a person owns in one response, so
 * the assertions that matter most are about what must stay out: trashed and
 * temporary chats, other people's rows, and files not owned by the requester.
 */
const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-export-'));

const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));

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
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), STORAGE_LOCAL_PATH: storageRoot }) };
});

const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
type AppBindings = import('../../middleware/context.js').AppBindings;

function appFor(userId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'owner@example.com',
      name: 'Owner',
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

async function download(userId: string) {
  const response = await appFor(userId).request('/api/me/export');
  expect(response.status).toBe(200);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return { response, files, names: Object.keys(files).sort() };
}

describe.skipIf(!available)('live Postgres: full account export', () => {
  let live: LiveDatabase;
  let ownerId: string;
  let strangerId: string;
  let activeThread: string;
  let ownerAssistantMessage: string;

  async function thread(userId: string, title: string, extra?: ReturnType<typeof sql>) {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title, created_at, updated_at)
      values (${state.organizationId}, ${userId}, ${title}, '2026-01-15T10:00:00Z', '2026-01-16T10:00:00Z')
      returning id
    `);
    if (!row) throw new Error('Failed to create thread');
    if (extra) {
      await live.db.execute(sql`update thread set ${extra} where id = ${row.id}`);
    }
    return row.id;
  }

  async function message(
    threadId: string,
    userId: string,
    role: string,
    parts: unknown,
    position: number,
  ) {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position, model_slug)
      values (${threadId}, ${userId}, ${role}, ${JSON.stringify(parts)}::jsonb, ${position},
              ${role === 'assistant' ? 'claude-sonnet-4-6' : null})
      returning id
    `);
    if (!row) throw new Error('Failed to create message');
    return row.id;
  }

  async function attachment(params: {
    userId: string;
    messageId: string | null;
    filename: string;
    body: string;
    deleted?: boolean;
    pending?: boolean;
  }) {
    const key = `${params.userId}/${crypto.randomUUID()}.txt`;
    await new LocalStorageDriver(storageRoot).put(key, Buffer.from(params.body), 'text/plain');
    await live.db.execute(sql`
      insert into attachment (organization_id, user_id, message_id, filename, mime_type, size_bytes,
                              storage_key, upload_pending, deleted_at)
      values (${state.organizationId}, ${params.userId}, ${params.messageId}, ${params.filename},
              'text/plain', ${Buffer.byteLength(params.body)}, ${key}, ${params.pending ?? false},
              ${params.deleted ? new Date().toISOString() : null}::timestamptz)
    `);
  }

  beforeAll(async () => {
    live = await createLiveDatabase('portability_export');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    strangerId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });

    activeThread = await thread(ownerId, 'Migration planning');
    const prompt = await message(
      activeThread,
      ownerId,
      'user',
      [{ type: 'text', text: 'How should we migrate?' }],
      0,
    );
    ownerAssistantMessage = await message(
      activeThread,
      ownerId,
      'assistant',
      [
        { type: 'reasoning', text: 'internal deliberation' },
        { type: 'text', text: 'Start with the schema.' },
      ],
      1,
    );
    await attachment({
      userId: ownerId,
      messageId: prompt,
      filename: 'notes.txt',
      body: 'owner bytes',
    });
    await attachment({
      userId: ownerId,
      messageId: prompt,
      filename: 'notes.txt',
      body: 'second file, same name',
    });
    await attachment({
      userId: ownerId,
      messageId: null,
      filename: 'draft.txt',
      body: 'unsent bytes',
    });
    await attachment({
      userId: ownerId,
      messageId: prompt,
      filename: 'half-uploaded.txt',
      body: 'pending bytes',
      pending: true,
    });
    await attachment({
      userId: ownerId,
      messageId: prompt,
      filename: 'removed.txt',
      body: 'deleted bytes',
      deleted: true,
    });
    // A row claiming someone else's file on the owner's message must not leak.
    await attachment({
      userId: strangerId,
      messageId: ownerAssistantMessage,
      filename: 'foreign.txt',
      body: 'stranger bytes',
    });

    const archived = await thread(ownerId, 'Archived idea', sql`archived = true`);
    await message(archived, ownerId, 'user', [{ type: 'text', text: 'Archived content' }], 0);

    const trashed = await thread(ownerId, 'Trashed secret', sql`deleted_at = now()`);
    await message(trashed, ownerId, 'user', [{ type: 'text', text: 'Trashed content' }], 0);

    const temporary = await thread(
      ownerId,
      'Temporary secret',
      sql`temporary = true, expires_at = now() + interval '1 day'`,
    );
    await message(temporary, ownerId, 'user', [{ type: 'text', text: 'Temporary content' }], 0);

    await thread(ownerId, 'Same title');
    await thread(ownerId, 'Same title');
    // Titles in other scripts name their files after their words (#361).
    for (const title of ['日本語の宿題', 'واجب الكتابة', 'Домашнее задание 📚']) {
      await thread(ownerId, title);
    }

    const foreign = await thread(strangerId, 'Stranger secret');
    await message(foreign, strangerId, 'user', [{ type: 'text', text: 'Stranger content' }], 0);
  });

  afterAll(async () => {
    await live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('streams a zip with Markdown and JSON for every live and archived conversation', async () => {
    const { response, names, files } = await download(ownerId);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toMatch(
      /oci-export-\d{4}-\d{2}-\d{2}\.zip/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');

    expect(names).toEqual(
      expect.arrayContaining([
        'conversations/migration-planning-2026-01-15.md',
        'conversations/migration-planning-2026-01-15.json',
        'conversations/archived-idea-2026-01-15.md',
        'conversations/archived-idea-2026-01-15.json',
        // Colliding titles are disambiguated rather than overwritten.
        'conversations/same-title-2026-01-15.md',
        'conversations/same-title-2026-01-15-2.md',
        'conversations/日本語の宿題-2026-01-15.md',
        'conversations/واجب-الكتابة-2026-01-15.md',
        'conversations/домашнее-задание-2026-01-15.md',
        'manifest.json',
        'README.txt',
      ]),
    );

    const markdown = strFromU8(
      files['conversations/migration-planning-2026-01-15.md'] as Uint8Array,
    );
    expect(markdown).toContain('# Migration planning');
    expect(markdown).toContain('Start with the schema.');
    expect(markdown).not.toContain('internal deliberation');

    const record = JSON.parse(
      strFromU8(files['conversations/migration-planning-2026-01-15.json'] as Uint8Array),
    );
    expect(record.thread).toMatchObject({ id: activeThread, title: 'Migration planning' });
    expect(record.messages).toHaveLength(2);
    // JSON is the complete record, so reasoning is kept there.
    expect(JSON.stringify(record.messages[1].parts)).toContain('internal deliberation');
    expect(record.messages[1]).toMatchObject({ id: ownerAssistantMessage, role: 'assistant' });
  });

  it('excludes trashed, temporary and other people’s conversations', async () => {
    const { names, files } = await download(ownerId);
    const everything = names.map((name) => strFromU8(files[name] as Uint8Array)).join('\n');
    expect(names.some((name) => name.includes('trashed'))).toBe(false);
    expect(names.some((name) => name.includes('temporary'))).toBe(false);
    expect(names.some((name) => name.includes('stranger'))).toBe(false);
    expect(everything).not.toContain('Trashed content');
    expect(everything).not.toContain('Temporary content');
    expect(everything).not.toContain('Stranger content');
  });

  it('includes only the owner’s ready, live attachment bytes', async () => {
    const { names, files } = await download(ownerId);
    const folder = 'attachments/migration-planning-2026-01-15';
    expect(strFromU8(files[`${folder}/notes.txt`] as Uint8Array)).toBe('owner bytes');
    expect(strFromU8(files[`${folder}/notes (2).txt`] as Uint8Array)).toBe(
      'second file, same name',
    );
    expect(strFromU8(files['attachments/unsent/draft.txt'] as Uint8Array)).toBe('unsent bytes');

    const everything = names.map((name) => strFromU8(files[name] as Uint8Array)).join('\n');
    expect(everything).not.toContain('stranger bytes');
    expect(everything).not.toContain('pending bytes');
    expect(everything).not.toContain('deleted bytes');
    expect(names.some((name) => name.includes('foreign'))).toBe(false);

    const record = JSON.parse(
      strFromU8(files['conversations/migration-planning-2026-01-15.json'] as Uint8Array),
    );
    expect(record.attachments.map((file: { path: string }) => file.path).sort()).toEqual([
      `${folder}/notes (2).txt`,
      `${folder}/notes.txt`,
    ]);
  });

  it('writes a manifest with versions and counts, and records an audit event', async () => {
    const { files } = await download(ownerId);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    expect(manifest).toMatchObject({
      exportVersion: 1,
      generator: 'open-chat-interface',
      counts: { conversations: 7, messages: 3, attachments: 3, omittedAttachments: 0 },
      truncated: false,
    });
    expect(typeof manifest.ociVersion).toBe('string');
    expect(strFromU8(files['README.txt'] as Uint8Array)).toContain('Conversations: 7');

    const audits = await live.db.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_log
      where action = 'user.export' and actor_user_id = ${ownerId}
    `);
    expect(audits[0]?.count).toBeGreaterThan(0);
  });

  it('includes the person’s memories, newest first, and nobody else’s', async () => {
    await live.db.execute(sql`
      insert into user_memory (user_id, content, source, thread_id, updated_at)
      values (${ownerId}, 'Prefers metric units', 'person', null, '2026-01-01T00:00:00Z'),
             (${ownerId}, 'Teaches chemistry', 'tool', ${activeThread}, '2026-02-01T00:00:00Z'),
             (${strangerId}, 'Stranger memory', 'person', null, '2026-03-01T00:00:00Z')
    `);
    try {
      const { files } = await download(ownerId);
      const memory = JSON.parse(strFromU8(files['memory.json'] as Uint8Array));
      expect(
        memory.memories.map((entry: { content: string; source: string }) => [
          entry.content,
          entry.source,
        ]),
      ).toEqual([
        ['Teaches chemistry', 'tool'],
        ['Prefers metric units', 'person'],
      ]);
      expect(memory.memories[0].threadId).toBe(activeThread);
      const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
      expect(manifest.counts.memories).toBe(2);
      expect(strFromU8(files['README.txt'] as Uint8Array)).toContain('Memories: 2');

      const other = await download(strangerId);
      const theirs = JSON.parse(strFromU8(other.files['memory.json'] as Uint8Array));
      expect(theirs.memories.map((entry: { content: string }) => entry.content)).toEqual([
        'Stranger memory',
      ]);
    } finally {
      await live.db.execute(sql`delete from user_memory`);
    }
  });

  it('gives another person an export of only their own data', async () => {
    const { names, files } = await download(strangerId);
    expect(names.filter((name) => name.startsWith('conversations/'))).toEqual([
      'conversations/stranger-secret-2026-01-15.json',
      'conversations/stranger-secret-2026-01-15.md',
    ]);
    // Their attachment row points at the owner's message, so it is not theirs to export either.
    expect(names.some((name) => name.startsWith('attachments/'))).toBe(false);
    expect(JSON.stringify(Object.values(files).map((file) => strFromU8(file)))).not.toContain(
      'Migration planning',
    );
  });

  it('allows one export at a time per person', async () => {
    const first = await appFor(ownerId).request('/api/me/export');
    expect(first.status).toBe(200);

    const second = await appFor(ownerId).request('/api/me/export');
    expect(second.status).toBe(429);

    // Someone else is unaffected.
    const other = await appFor(strangerId).request('/api/me/export');
    expect(other.status).toBe(200);
    await other.arrayBuffer();

    await first.arrayBuffer();
    const third = await appFor(ownerId).request('/api/me/export');
    expect(third.status).toBe(200);
    await third.arrayBuffer();
  });
});
