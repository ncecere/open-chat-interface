import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema } from '@oci/db';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copiesHarness, defaultSettings } from '../../../test/attachment-copies.fixtures.js';
import { shareFilesWithSource } from '../../../test/chat-attachment-context.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * The exports of a fork and an edit list the files they show (#364). The full
 * export (`GET /api/me/export`) listed none for them: their messages carried
 * the original's attachment id and the files were found only through the
 * conversation that owned them, so the JSON said `"attachments": []` beside a
 * Markdown that said "Attached", and the folder of the fork was missing. Real
 * routes, real PostgreSQL, local storage, and the archive read back as a ZIP.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  driver: null as unknown,
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/limits/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/limits/rate-limit.js')>()),
  consumeRateLimit: async () => ({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 1 }),
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
}));
vi.mock('../../services/storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));

const available = await livePostgresAvailable();
const TEXT = 'The drainage trench costs $650 and the project starts in March 2027.';

interface ExportedConversation {
  thread: { id: string; title: string };
  messages: Array<{ id: string; parts: Array<{ type: string; data?: { id: string } }> }>;
  attachments: Array<{
    id: string;
    messageId: string | null;
    filename: string;
    path: string | null;
  }>;
}

describe.skipIf(!available)('live: the export lists the files of forks and edits (#364)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  const h = copiesHarness({
    get pool() {
      return pool;
    },
    state: state as never,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('export_fork_files');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    root = await mkdtemp(join(tmpdir(), 'oci-export-forks-'));
    state.driver = new LocalStorageDriver(root);
  });
  beforeEach(async () => {
    state.settings = defaultSettings();
    owner = await seedUser(pool.db, state.organizationId);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** The whole export, read back: each conversation's JSON by thread id, and the file entries. */
  async function fullExport() {
    const response = await h.call(owner, 'GET', '/api/me/export');
    expect(response.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const conversations = new Map<string, ExportedConversation>();
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.startsWith('conversations/') || !name.endsWith('.json')) continue;
      const parsed = JSON.parse(strFromU8(bytes)) as ExportedConversation;
      conversations.set(parsed.thread.id, parsed);
    }
    return { entries, conversations };
  }

  /** The files an exported conversation lists, with the bytes the archive holds for each. */
  function listed(
    exported: { entries: Record<string, Uint8Array> },
    conversation: ExportedConversation,
  ) {
    return conversation.attachments.map((file) => ({
      filename: file.filename,
      messageId: file.messageId,
      text:
        file.path && exported.entries[file.path] ? strFromU8(exported.entries[file.path]!) : null,
    }));
  }

  async function family() {
    const original = await h.conversation(owner, { text: TEXT });
    const fork = await h.fork(owner, original.thread.id, original.reply.id);
    const edit = await h.edit(owner, original.thread.id, original.question.id, 'Again?');
    return { original, fork, edit };
  }

  it('lists the file of a normal conversation, a fork and an edit, each in its own folder', async () => {
    const { original, fork, edit } = await family();
    const exported = await fullExport();
    for (const threadId of [original.thread.id, fork, edit]) {
      const conversation = exported.conversations.get(threadId)!;
      const shown = conversation.messages.flatMap((message) =>
        message.parts.filter((part) => part.type === 'data-attachment'),
      );
      // The messages carry the file ...
      expect(shown).toHaveLength(1);
      // ... and so does the list, with its bytes, against one of the messages.
      expect(listed(exported, conversation)).toEqual([
        {
          filename: 'grant.txt',
          messageId: expect.stringMatching(/./),
          text: TEXT,
        },
      ]);
      expect(conversation.messages.map((message) => message.id)).toContain(
        conversation.attachments[0]!.messageId,
      );
      expect(conversation.attachments[0]!.id).toBe(shown[0]!.data!.id);
    }
    // One folder per conversation (three), each with its file.
    const folders = Object.keys(exported.entries).filter(
      (name) => name.startsWith('attachments/') && name.endsWith('grant.txt'),
    );
    expect(new Set(folders.map((name) => name.split('/')[1])).size).toBe(3);
    // A file in the manifest's count is counted per conversation.
    const manifest = JSON.parse(strFromU8(exported.entries['manifest.json']!)) as {
      counts: { attachments: number };
    };
    expect(manifest.counts.attachments).toBe(3);
  });

  it('still has the fork’s and the edit’s files in the export after the original is deleted', async () => {
    const { original, fork, edit } = await family();
    await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
    await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}/permanent`);
    await h.drain();
    const exported = await fullExport();
    expect(exported.conversations.has(original.thread.id)).toBe(false);
    for (const threadId of [fork, edit]) {
      expect(listed(exported, exported.conversations.get(threadId)!)).toMatchObject([
        { filename: 'grant.txt', text: TEXT },
      ]);
    }
  });

  it('lists the file of a fork made before 0.11 too, against the message that shows it', async () => {
    const { original, fork } = await family();
    // As the previous release left it: the original's id, no row of its own.
    await shareFilesWithSource(pool, fork);
    expect(await h.filesOf(fork)).toHaveLength(0);
    const exported = await fullExport();
    const conversation = exported.conversations.get(fork)!;
    expect(listed(exported, conversation)).toMatchObject([{ filename: 'grant.txt', text: TEXT }]);
    expect(conversation.attachments[0]!.id).toBe(original.file.id);
    const [questionCopy] = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, fork))
      .orderBy(schema.message.position);
    expect(conversation.attachments[0]!.messageId).toBe(questionCopy!.id);
    // The original is still listed once, in its own folder, with its own message.
    expect(exported.conversations.get(original.thread.id)!.attachments[0]!.messageId).toBe(
      original.question.id,
    );
  });

  it('never lists a file that is not the person’s, a removed one or a project file', async () => {
    const { original, fork } = await family();
    const stranger = await seedUser(pool.db, state.organizationId);
    const theirs = await h.conversation(stranger, { filename: 'theirs.txt', text: 'theirs' });
    await shareFilesWithSource(pool, fork);
    const [forkQuestion] = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, fork))
      .orderBy(schema.message.position);
    // A copy that names another person's file and a removed one.
    await pool.db
      .update(schema.message)
      .set({
        parts: [
          ...forkQuestion!.parts,
          {
            type: 'data-attachment',
            data: { id: theirs.file.id, filename: 'theirs.txt', mimeType: 'text/plain', url: '' },
          },
        ],
      })
      .where(eq(schema.message.id, forkQuestion!.id));
    await pool.db
      .update(schema.attachment)
      .set({ deletedAt: new Date(), deletedReason: 'user' })
      .where(eq(schema.attachment.id, original.file.id));
    const exported = await fullExport();
    expect(exported.conversations.get(fork)!.attachments).toEqual([]);
    // Their file is neither listed nor in the archive, though the part names it.
    expect(
      [...exported.conversations.values()].flatMap((conversation) =>
        conversation.attachments.map((file) => file.id),
      ),
    ).not.toContain(theirs.file.id);
    expect(Object.keys(exported.entries).some((name) => name.endsWith('theirs.txt'))).toBe(false);
  });

  it('names the files in the single-conversation export of a normal conversation, a fork and an edit', async () => {
    const { original, fork, edit } = await family();
    for (const threadId of [original.thread.id, fork, edit]) {
      const response = await h.call(owner, 'GET', `/api/threads/${threadId}/export`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('_Attached: grant.txt_');
    }
  });
});
