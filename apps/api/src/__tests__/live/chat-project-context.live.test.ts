import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  addCost,
  contextBudget,
  fitsContext,
  MESSAGE_OVERHEAD,
  messageCost,
  textCost,
} from '../../services/chat/context-budget.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * A conversation's project in the model context: instructions in the system
 * prompt, files through the attachment-context path and the context budget.
 * Admission, history, attachment selection, blob I/O, persistence and SDK
 * conversion are real; setupTurn stops before any provider is called.
 */
type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  system: 'INSTANCE PROMPT AND PERSONAL CUSTOMISATION',
  attachments: true,
  roleFeatures: {} as Record<string, unknown>,
  contextWindow: undefined as number | undefined,
  maxOutputTokens: undefined as number | undefined,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: state.contextWindow,
    maxOutputTokens: state.maxOutputTokens,
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: state.attachments, temporaryChat: true };
    if (key === 'storage') return { maxFilesPerMessage: 10 };
    if (key === 'roleFeatures') return state.roleFeatures;
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => state.system,
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
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

async function modelText(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages
    .flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

/** What the assembled request costs, measured the way the budget measures it. */
function assembledCost(started: StartedTurn) {
  const system = textCost(started.turn.system);
  return started.turn.uiMessages.reduce((sum, message) => addCost(sum, messageCost(message)), {
    ...system,
    units: system.units + MESSAGE_OVERHEAD,
  });
}

describe.skipIf(!available)('live: project context in chat turns', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let driver: LocalStorageDriver;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('project_context');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-project-context-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
  });
  beforeEach(() => {
    state.system = 'INSTANCE PROMPT AND PERSONAL CUSTOMISATION';
    state.attachments = true;
    state.roleFeatures = {};
    state.contextWindow = undefined;
    state.maxOutputTokens = undefined;
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

  async function project(name: string, instructions = '') {
    const [row] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId: owner, name, instructions })
      .returning();
    return row!;
  }
  async function projectFile(projectId: string, filename: string, text: string) {
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: owner,
        projectId,
        filename,
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    await driver.put(row!.storageKey, Buffer.from(text), 'text/plain');
    return row!;
  }
  async function thread(projectId: string | null) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, projectId })
      .returning();
    return row!;
  }
  async function messages(threadId: string) {
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function history(threadId: string, turns: Array<[string, string]>) {
    let position = 0;
    for (const [user, assistant] of turns) {
      await pool.db.insert(schema.message).values([
        {
          threadId,
          userId: owner,
          role: 'user',
          parts: [{ type: 'text', text: user }],
          position: position++,
        },
        {
          threadId,
          userId: owner,
          role: 'assistant',
          parts: [{ type: 'text', text: assistant }],
          position: position++,
        },
      ]);
    }
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: owner, name: 'Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
        ...extra,
      },
    );
    runs.add(started.run);
    return started;
  }
  async function complete(started: StartedTurn) {
    await pool.db
      .update(schema.message)
      .set({ status: 'complete', parts: [{ type: 'text', text: 'Fixture reply' }] })
      .where(eq(schema.message.id, started.run.assistantMessage.id));
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    await releaseRunHandles(started.run, true);
    runs.delete(started.run);
  }

  it('adds the instructions after the instance and personal prompt, delimited', async () => {
    const research = await project('Thesis\nwork', 'Always answer in French.');
    const started = await send((await thread(research.id)).id, 'Hello');
    const system = started.turn.system;

    expect(system.startsWith(state.system)).toBe(true);
    expect(system).toContain(
      'This conversation belongs to the project "Thesis work". Follow the project\'s instructions below unless they conflict with the instructions above.',
    );
    expect(system).toContain(
      '<project_instructions>\nAlways answer in French.\n</project_instructions>',
    );
    expect(system.indexOf('Always answer in French.')).toBeGreaterThan(
      system.indexOf(state.system),
    );

    // Conversations outside a project, or in one without instructions, are unchanged.
    expect((await send((await thread(null)).id, 'Hello')).turn.system).toBe(state.system);
    const plain = await project('No instructions', '   ');
    expect((await send((await thread(plain.id)).id, 'Hello')).turn.system).toBe(state.system);
  });

  it('adds project file text through attachment context without storing it', async () => {
    const research = await project('Research');
    const file = await projectFile(research.id, 'facts.txt', 'The codename is Blue Heron.');
    const chat = await thread(research.id);

    const first = await send(chat.id, 'What is the codename?');
    const text = await modelText(first);
    expect(text).toContain('Files from the project "Research"');
    expect(text).toContain('Attached file "facts.txt":\n\nThe codename is Blue Heron.');
    expect(first.turn.contextLimited).toBe(false);
    await complete(first);

    // Every turn gets the files once, at the start of the context.
    const second = await send(chat.id, 'And again?');
    const followup = await modelText(second);
    expect(occurrences(followup, 'Blue Heron')).toBe(1);
    expect(followup.indexOf('Blue Heron')).toBeLessThan(followup.indexOf('What is the codename?'));

    // Nothing about the project is written into the conversation, and the
    // file stays the project's rather than becoming a message attachment.
    expect(JSON.stringify(await messages(chat.id))).not.toContain('Blue Heron');
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored).toMatchObject({ messageId: null, projectId: research.id, deletedAt: null });
  });

  it('includes only the files that fit, never exceeding the model context', async () => {
    // 3,000 units of input once the output reservation and margin are removed.
    state.contextWindow = 3000 + 1000 + 512;
    state.maxOutputTokens = 1000;
    const budget = contextBudget({
      contextWindow: state.contextWindow,
      maxOutputTokens: state.maxOutputTokens,
    });
    expect(budget.units).toBe(3000);

    const research = await project('Budgeted', 'Be brief.');
    await projectFile(research.id, 'huge.txt', `HUGE_FILE ${'x'.repeat(5000)}`);
    await projectFile(research.id, 'small.txt', 'SMALL_FILE fits easily.');
    const started = await send((await thread(research.id)).id, 'Summarise the files');
    const text = await modelText(started);

    expect(text).toContain('SMALL_FILE fits easily.');
    expect(text).not.toContain('HUGE_FILE');
    expect(started.turn.system).toContain('Be brief.');
    expect(started.turn.contextLimited).toBe(true);
    expect(fitsContext(assembledCost(started), budget)).toBe(true);
  });

  it('keeps project files ahead of older history, trimming the history instead', async () => {
    state.contextWindow = 3000 + 1000 + 512;
    state.maxOutputTokens = 1000;
    const budget = contextBudget({
      contextWindow: state.contextWindow,
      maxOutputTokens: state.maxOutputTokens,
    });
    const research = await project('History');
    await projectFile(research.id, 'brief.txt', `PROJECT_BRIEF ${'b'.repeat(1000)}`);
    const chat = await thread(research.id);
    await history(
      chat.id,
      Array.from({ length: 4 }, (_, index) => [
        `OLD_TURN_${index} ${'u'.repeat(300)}`,
        `OLD_REPLY_${index} ${'a'.repeat(300)}`,
      ]),
    );

    const started = await send(chat.id, 'Latest question');
    const text = await modelText(started);
    expect(text).toContain('PROJECT_BRIEF');
    expect(text).toContain('OLD_TURN_3');
    expect(text).not.toContain('OLD_TURN_0');
    expect(started.turn.contextLimited).toBe(true);
    expect(fitsContext(assembledCost(started), budget)).toBe(true);
  });

  it('adds nothing when the role may not use projects, but the conversation continues', async () => {
    const research = await project('Switched off', 'SECRET_INSTRUCTIONS');
    await projectFile(research.id, 'notes.txt', 'SECRET_FILE_TEXT');
    state.roleFeatures = { roles: { user: { projects: false } } };

    const started = await send((await thread(research.id)).id, 'Hello');
    expect(started.turn.system).toBe(state.system);
    expect(await modelText(started)).not.toContain('SECRET_FILE_TEXT');
  });

  it('keeps the instructions but leaves files out when attachments are not allowed', async () => {
    const research = await project('No files', 'KEEP_THESE_INSTRUCTIONS');
    await projectFile(research.id, 'notes.txt', 'FILE_TEXT_LEFT_OUT');

    for (const setup of [
      () => {
        state.attachments = false;
      },
      () => {
        state.roleFeatures = { roles: { user: { attachments: false } } };
      },
    ]) {
      state.attachments = true;
      state.roleFeatures = {};
      setup();
      const started = await send((await thread(research.id)).id, 'Hello');
      expect(started.turn.system).toContain('KEEP_THESE_INSTRUCTIONS');
      expect(await modelText(started)).not.toContain('FILE_TEXT_LEFT_OUT');
    }
  });

  it('refuses a project file sent as a message attachment, without writes', async () => {
    const research = await project('Not an upload');
    const file = await projectFile(research.id, 'notes.txt', 'Project only');
    const chat = await thread(null);

    await expect(send(chat.id, 'Attach it', { attachmentIds: [file.id] })).rejects.toMatchObject({
      status: 404,
    });
    expect(await messages(chat.id)).toEqual([]);
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored?.messageId).toBeNull();
  });

  it('cannot be pointed at someone else’s project', async () => {
    const stranger = await seedUser(pool.db, state.organizationId);
    const [theirs] = await pool.db
      .insert(schema.project)
      .values({
        organizationId: state.organizationId,
        userId: stranger,
        name: 'Theirs',
        instructions: 'THEIR_INSTRUCTIONS',
      })
      .returning();
    // Not reachable through the API; written directly to prove the turn's own check.
    const started = await send((await thread(theirs!.id)).id, 'Hello');
    expect(started.turn.system).toBe(state.system);
  });
});
