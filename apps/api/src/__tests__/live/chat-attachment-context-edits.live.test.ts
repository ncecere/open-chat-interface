import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentHelpers, modelText } from '../../../test/chat-attachment-context.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Editing a question that was sent with a file (#296): the edited question was
 * stored as text only, so its answer was made without the file. Through the
 * real branch route, real PostgreSQL, local blob storage and the real turn
 * preparation for the edit's answer (stopping before any provider call).
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  released: 0,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// Only environmental/policy dependencies are stubbed. The routes, branching,
// attachment loading, admission, persistence and blob I/O are real.
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: true, temporaryChat: true, branching: true };
    if (key === 'storage') return { maxFilesPerMessage: 10 };
    if (key === 'roleFeatures') return {};
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({
    release: async () => {
      state.released++;
    },
  }),
}));
vi.mock('../../services/quota/index.js', () => ({
  reserveQuotaForRun: async () => null,
  releaseReservation: async () => {},
  settleReservation: async () => {},
  recordUsage: async () => {},
}));
vi.mock('../../services/chat-streams.js', () => ({
  beginChatRun: async () => 'unavailable',
  abandonChatRun: async () => {},
  unregisterLocalChatRun: () => {},
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live edits of a question with files (#296)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let stranger: string;
  let driver: LocalStorageDriver;
  let app: Hono<AppBindings>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('attachment_edits');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-attachment-edits-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
  });
  beforeEach(() => {
    state.released = 0;
  });
  afterEach(async () => {
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const { thread, messages, attachment, send, complete } = attachmentHelpers({
    get pool() {
      return pool;
    },
    get owner() {
      return owner;
    },
    get organizationId() {
      return state.organizationId;
    },
    get driver() {
      return driver;
    },
    runs,
    state,
  });

  /** A conversation whose question was sent with a file and answered. */
  async function answeredWithFile(content = 'The lab mascot is called OSPREY-ZETA.') {
    const chat = await thread();
    const file = await attachment('text/plain', content);
    const first = await send(chat.id, 'What is the lab mascot called?', {
      attachmentIds: [file.id],
    });
    await complete(first);
    return { chat, file, question: first.turn.promptMessageId };
  }
  function branch(threadId: string, body: Record<string, unknown>, user = owner) {
    return app.request(`/api/threads/${threadId}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(body),
    });
  }
  /** The edit's answer, as the page asks for it: a retry of the stored question, by id. */
  async function answer(threadId: string, messageId: string, text: string) {
    return send(threadId, text, {
      trigger: 'regenerate-message',
      messages: [{ id: messageId, role: 'user', parts: [{ type: 'text', text }] }],
    });
  }
  const partTypes = (row: { parts: unknown }) =>
    (row.parts as { type: string }[]).map((part) => part.type);

  it('keeps the question’s file, and its answer is made with the file', async () => {
    const { chat, file, question } = await answeredWithFile();
    const response = await branch(chat.id, {
      messageId: question,
      text: 'What is the lab mascot called? One line.',
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { thread: { id: string }; message: { id: string } };
    const [edited] = await messages(result.thread.id);
    expect(edited?.id).toBe(result.message.id);
    expect(partTypes(edited!)).toEqual(['text', 'data-attachment']);
    expect(JSON.stringify(edited!.parts)).toContain(file.id);

    const started = await answer(
      result.thread.id,
      result.message.id,
      'What is the lab mascot called? One line.',
    );
    const text = await modelText(started);
    expect(text).toContain('What is the lab mascot called? One line.');
    expect(text).toContain('OSPREY-ZETA');
    // The file stays the original question's: nothing is re-allocated.
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored?.messageId).toBe(question);
  });

  it('keeps only the files listed, and leaves a removed one out of the answer', async () => {
    const { chat, question } = await answeredWithFile();
    const response = await branch(chat.id, {
      messageId: question,
      text: 'Without the file this time.',
      attachmentIds: [],
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { thread: { id: string }; message: { id: string } };
    expect(partTypes((await messages(result.thread.id))[0]!)).toEqual(['text']);
    const started = await answer(
      result.thread.id,
      result.message.id,
      'Without the file this time.',
    );
    expect(await modelText(started)).not.toContain('OSPREY-ZETA');
  });

  it('refuses a file the question was not sent with, and creates nothing', async () => {
    const { chat, file, question } = await answeredWithFile();
    const other = await attachment('text/plain', 'UNSENT_UPLOAD_CONTENT');
    const before = await pool.db.select({ id: schema.thread.id }).from(schema.thread);
    const response = await branch(chat.id, {
      messageId: question,
      text: 'Smuggle another file in.',
      attachmentIds: [file.id, other.id],
    });
    expect(response.status).toBe(422);
    expect(await pool.db.select({ id: schema.thread.id }).from(schema.thread)).toEqual(before);
    const [unsent] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, other.id));
    expect(unsent?.messageId).toBeNull();
  });

  it('is refused to anyone but the conversation’s owner', async () => {
    const { chat, question } = await answeredWithFile();
    const response = await branch(chat.id, { messageId: question, text: 'Mine now' }, stranger);
    expect(response.status).toBe(404);
  });

  it('follows the original question’s access: a deleted source leaves the file out', async () => {
    const { chat, question } = await answeredWithFile();
    const response = await branch(chat.id, { messageId: question, text: 'Edited.' });
    const result = (await response.json()) as { thread: { id: string }; message: { id: string } };
    await pool.db
      .update(schema.thread)
      .set({ deletedAt: new Date() })
      .where(eq(schema.thread.id, chat.id));
    const started = await answer(result.thread.id, result.message.id, 'Edited.');
    const text = await modelText(started);
    expect(text).not.toContain('OSPREY-ZETA');
    expect(text).toMatch(/no longer available/i);
  });
});
