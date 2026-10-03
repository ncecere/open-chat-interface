import { createDatabase, eq, schema, sql } from '@oci/db';
import { MAX_ARTIFACT_BYTES } from '@oci/shared';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Artifacts (v0.9) through real PostgreSQL, the real chat, thread and
 * artifact routes, turn preparation, reply persistence, storage accounting,
 * exports and share links, with a scripted model in place of a provider.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: ['tool_calling'] as string[],
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 400_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
const defaults: Record<string, unknown> = {
  features: {
    webSearch: false,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  },
  search: { enabled: false, provider: null, baseUrl: null, encryptedApiKey: null, maxResults: 5 },
  chat: { defaultSystemPrompt: null },
  branding: { accentColor: '#3366ff' },
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key] ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? defaults[key] ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  beginChatRun: async () => 'unavailable',
}));

const available = await livePostgresAvailable();

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
function toolStep(calls: Array<[id: string, tool: string, input: unknown]>) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      ...calls.map(([toolCallId, toolName, value]) => ({
        type: 'tool-call' as const,
        toolCallId,
        toolName,
        input: JSON.stringify(value),
      })),
      {
        type: 'finish' as const,
        usage: usage(10, 5),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      },
    ]),
  };
}
function textStep(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't' },
      { type: 'text-delta' as const, id: 't', delta: text },
      { type: 'text-end' as const, id: 't' },
      {
        type: 'finish' as const,
        usage: usage(20, 7),
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      },
    ]),
  };
}
function script(...steps: unknown[]) {
  let next = 0;
  const model = new MockLanguageModelV4({
    doStream: (async () => {
      const step = steps[next++];
      if (!step) throw new Error('The scripted model has no more steps');
      // A function builds its step when called, from what earlier steps stored.
      return typeof step === 'function' ? await step() : step;
    }) as never,
  });
  state.model = model;
  return model;
}
const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();
const systemOf = (model: MockLanguageModelV4, call = 0) =>
  JSON.stringify(
    ((model.doStreamCalls[call]?.prompt ?? []) as Array<{ role: string; content: unknown }>).filter(
      (message) => message.role === 'system',
    ),
  );

const HTML_PAGE = [
  '<!doctype html>',
  '<html><head><title>Sales &amp; chart</title></head>',
  '<body><h1>Sales</h1><script data-oci-library="d3"></script></body></html>',
].join('\n');
const SVG_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Dot</title><circle r="4" cx="5" cy="5"/></svg>';
const MERMAID = 'flowchart LR\n  A[Start] --> B[Middle]\n  B --> C[End]';
const REPLY = [
  'Here is the page:',
  '```html',
  HTML_PAGE,
  '```',
  'A small snippet that stays code:',
  '```html',
  '<b>bold</b>',
  '```',
  'Some Python:',
  '```python',
  'print("hi")',
  '```',
  '```svg',
  SVG_IMAGE,
  '```',
  '```mermaid',
  MERMAID,
  '```',
  '```mermaid',
  'graph TD',
  '```',
].join('\n');

describe.skipIf(!available)('live artifacts', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('artifacts');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { artifactRoutes } = await import('../../routes/artifacts.js');
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
        role: (c.req.header('x-test-role') as 'user') ?? 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
    app.route('/api/artifacts', artifactRoutes);
    app.route('/api/threads', threadRoutes);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
  });
  afterEach(async () => {
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from storage_policy`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread(user = owner) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Artifacts chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position, schema.message.createdAt);
  }
  async function settled(threadId: string) {
    await vi.waitFor(
      async () => {
        const stored = await rows(threadId);
        expect(stored.some((row) => row.status === 'streaming')).toBe(false);
      },
      { timeout: 5_000, interval: 20 },
    );
    return rows(threadId);
  }
  async function turn(
    threadId: string,
    text: string,
    options: {
      role?: string;
      user?: string;
      regenerate?: string;
    } = {},
  ) {
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.role ? { 'x-test-role': options.role } : {}),
        ...(options.user ? { 'x-test-user': options.user } : {}),
      },
      body: JSON.stringify({
        threadId,
        modelSlug: 'artifact-model',
        messages: [
          {
            ...(options.regenerate ? { id: options.regenerate } : {}),
            role: 'user',
            parts: [{ type: 'text', text }],
          },
        ],
        webSearch: false,
        ...(options.regenerate ? { trigger: 'regenerate-message' } : {}),
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    // Detection runs as the reply is stored; wait for it to settle as well.
    const stored = await settled(threadId);
    return { reply: stored.filter((row) => row.role === 'assistant').at(-1)!, stored };
  }
  async function artifactsOf(threadId: string) {
    return pool.db
      .select()
      .from(schema.artifact)
      .where(eq(schema.artifact.threadId, threadId))
      .orderBy(schema.artifact.createdAt, schema.artifact.sourceKey);
  }
  async function versionsOf(artifactId: string) {
    return pool.db
      .select()
      .from(schema.artifactVersion)
      .where(eq(schema.artifactVersion.artifactId, artifactId))
      .orderBy(schema.artifactVersion.version);
  }
  function get(path: string, user = owner) {
    return app.request(path, { headers: { 'x-test-user': user } });
  }
  function post(path: string, body: unknown, user = owner) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(body),
    });
  }
  async function waitForArtifacts(threadId: string, count: number) {
    await vi.waitFor(async () => expect(await artifactsOf(threadId)).toHaveLength(count), {
      timeout: 5_000,
      interval: 20,
    });
    return artifactsOf(threadId);
  }
  /** A thread with one complete reply and its detected artifacts, without a model. */
  async function seededReply(text: string, user = owner) {
    const chat = await thread(user);
    const [prompt, reply] = await pool.db
      .insert(schema.message)
      .values([
        {
          threadId: chat.id,
          userId: user,
          role: 'user',
          position: 0,
          parts: [{ type: 'text', text: 'Draw' }],
        },
        {
          threadId: chat.id,
          userId: user,
          role: 'assistant',
          position: 1,
          parts: [{ type: 'text', text }],
        },
      ])
      .returning();
    const { saveDetectedArtifacts } = await import('../../services/artifacts/store.js');
    await saveDetectedArtifacts({
      userId: user,
      role: 'user',
      threadId: chat.id,
      messageId: reply!.id,
      parts: reply!.parts,
    });
    return { chat, prompt: prompt!, reply: reply! };
  }

  describe('detection in finished replies', () => {
    it('saves HTML, SVG and Mermaid blocks of a few lines; ordinary code stays code', async () => {
      state.capabilities = [];
      const chat = await thread();
      script(textStep(REPLY));
      const { reply } = await turn(chat.id, 'Make me a page');
      const artifacts = await waitForArtifacts(chat.id, 3);
      expect(
        artifacts.map((artifact) => [artifact.sourceKey, artifact.kind, artifact.title]),
      ).toEqual([
        ['block:0', 'html', 'Sales & chart'],
        ['block:3', 'svg', 'Dot'],
        ['block:4', 'mermaid', 'Flowchart'],
      ]);
      expect(artifacts.every((artifact) => artifact.messageId === reply.id)).toBe(true);
      const [html] = await versionsOf(artifacts[0]!.id);
      expect(html).toMatchObject({
        version: 1,
        content: HTML_PAGE,
        sizeBytes: Buffer.byteLength(HTML_PAGE),
        source: 'reply',
        messageId: reply.id,
      });
    });

    it('is idempotent when the stored reply is processed again (replay or retried persistence)', async () => {
      const { chat, reply } = await seededReply(REPLY);
      const before = await artifactsOf(chat.id);
      expect(before).toHaveLength(3);
      const { saveDetectedArtifacts } = await import('../../services/artifacts/store.js');
      const again = await Promise.all(
        [1, 2, 3].map(() =>
          saveDetectedArtifacts({
            userId: owner,
            role: 'user',
            threadId: chat.id,
            messageId: reply.id,
            parts: reply.parts,
          }),
        ),
      );
      expect(again.reduce((sum, count) => sum + count, 0)).toBe(0);
      const after = await artifactsOf(chat.id);
      expect(after.map((artifact) => artifact.id)).toEqual(before.map((artifact) => artifact.id));
      for (const artifact of after) expect(await versionsOf(artifact.id)).toHaveLength(1);
    });

    it('gives a retried reply its own artifacts and keeps the replaced reply’s', async () => {
      state.capabilities = [];
      const chat = await thread();
      script(
        textStep(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``),
        textStep(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``),
      );
      const first = await turn(chat.id, 'Draw a dot');
      await waitForArtifacts(chat.id, 1);
      const prompt = first.stored.find((row) => row.role === 'user')!;
      const second = await turn(chat.id, 'Draw a dot', { regenerate: prompt.id });
      expect(second.reply.id).not.toBe(first.reply.id);
      const artifacts = await waitForArtifacts(chat.id, 2);
      expect(artifacts.map((artifact) => artifact.messageId).sort()).toEqual(
        [first.reply.id, second.reply.id].sort(),
      );
    });

    it('saves nothing when the role switch is off, or for restricted accounts by default', async () => {
      state.capabilities = [];
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const chat = await thread();
      script(textStep(REPLY));
      await turn(chat.id, 'Make me a page');
      const restricted = await seedUser(pool.db, state.organizationId, { role: 'restricted' });
      const other = await thread(restricted);
      script(textStep(REPLY));
      await turn(other.id, 'Make me a page', { role: 'restricted', user: restricted });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
      expect(await artifactsOf(other.id)).toHaveLength(0);
    });

    it('leaves oversize blocks as code', async () => {
      const big = `<svg>${'x'.repeat(MAX_ARTIFACT_BYTES)}</svg>`;
      const { chat } = await seededReply(`\`\`\`svg\n${big}\n\`\`\``);
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });
  });

  describe('artifact tools', () => {
    it('offers create_artifact and update_artifact to tool-capable models, with guidance', async () => {
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Hi');
      expect(offered(model)).toEqual(['create_artifact', 'update_artifact']);
      const system = systemOf(model);
      expect(system).toContain('create_artifact');
      expect(system).toContain('data-oci-library=\\"d3\\"');
      expect(system).toContain('Diagram Design by Cathryn Lavery, MIT');
      expect(system).toContain('#3366ff');
      // Program code stays in the reply as code blocks; artifacts are never linked.
      const { PROGRAM_CODE_IN_CHAT } = await import('../../services/artifacts/guidance.js');
      expect(system).toContain(PROGRAM_CODE_IN_CHAT);
      expect(system).toContain('Never link to an artifact');
      expect(system).not.toContain('also for long Markdown documents');
      const tool = (model.doStreamCalls[0]?.tools ?? []).find(
        (entry) => 'name' in entry && entry.name === 'create_artifact',
      );
      expect(tool && 'description' in tool ? tool.description : '').toContain(
        'Never use it for program code',
      );
    });

    it('offers no artifact tools and no guidance when the role switch is off', async () => {
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Hi');
      expect(offered(model)).toEqual([]);
      expect(systemOf(model)).not.toContain('Artifacts');
    });

    it('drops the diagram guidance when the administrator turns it off', async () => {
      state.settings.set('chat', { defaultSystemPrompt: null, diagramGuidance: false });
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Hi');
      expect(systemOf(model)).toContain('create_artifact');
      expect(systemOf(model)).not.toContain('Diagram Design');
    });

    it('guides models without tool calling to fenced blocks', async () => {
      state.capabilities = [];
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Hi');
      expect(model.doStreamCalls[0]?.tools).toBeUndefined();
      expect(systemOf(model)).toContain('single fenced code block');
      expect(systemOf(model)).not.toContain('create_artifact');
    });

    it('creates, edits with find-and-replace and replaces content, without approval', async () => {
      const chat = await thread();
      script(
        toolStep([
          [
            'c1',
            'create_artifact',
            { title: 'Plan', kind: 'markdown', content: '# Plan\n\nStep one.' },
          ],
        ]),
        textStep('Created.'),
      );
      const created = await turn(chat.id, 'Write a plan');
      const [artifact] = await artifactsOf(chat.id);
      expect(artifact).toMatchObject({
        sourceKey: 'tool:c1',
        kind: 'markdown',
        title: 'Plan',
        currentVersion: 1,
        messageId: created.reply.id,
      });
      const createPart = created.reply.parts.find((part) => part.type === 'tool-create_artifact');
      expect(createPart).toMatchObject({
        state: 'output-available',
        output: { artifactId: artifact!.id, version: 1, kind: 'markdown', title: 'Plan' },
      });

      const model = script(
        toolStep([
          [
            'u1',
            'update_artifact',
            {
              artifactId: artifact!.id,
              edits: [{ find: 'Step one.', replace: 'Step one.\nStep two.' }],
            },
          ],
        ]),
        toolStep([
          [
            'u2',
            'update_artifact',
            { artifactId: artifact!.id, content: '# Plan\n\nAll new.', title: 'New plan' },
          ],
        ]),
        textStep('Updated.'),
      );
      const updated = await turn(chat.id, 'Add a step');
      // The prompt lists the conversation's artifacts so the model can address them.
      expect(systemOf(model)).toContain(artifact!.id);
      const versions = await versionsOf(artifact!.id);
      expect(
        versions.map((version) => [version.version, version.content, version.messageId]),
      ).toEqual([
        [1, '# Plan\n\nStep one.', created.reply.id],
        [2, '# Plan\n\nStep one.\nStep two.', updated.reply.id],
        [3, '# Plan\n\nAll new.', updated.reply.id],
      ]);
      const [after] = await artifactsOf(chat.id);
      expect(after).toMatchObject({ currentVersion: 3, title: 'New plan' });
      expect(updated.reply.parts.some((part) => part.state === 'approval-requested')).toBe(false);
    });

    it('refuses an edit whose text is missing or ambiguous, and oversize content', async () => {
      const chat = await thread();
      script(
        toolStep([['c1', 'create_artifact', { title: 'Doc', kind: 'markdown', content: 'a a b' }]]),
        async () => {
          const [artifact] = await artifactsOf(chat.id);
          const id = artifact!.id;
          return toolStep([
            ['u1', 'update_artifact', { artifactId: 'nope', content: 'x' }],
            ['u2', 'update_artifact', { artifactId: id, edits: [{ find: 'zzz', replace: 'y' }] }],
            ['u3', 'update_artifact', { artifactId: id, edits: [{ find: 'a', replace: 'y' }] }],
            [
              'u4',
              'update_artifact',
              { artifactId: id, content: 'x', edits: [{ find: 'b', replace: 'c' }] },
            ],
            [
              'u5',
              'update_artifact',
              { artifactId: id, content: '\u00e9'.repeat(MAX_ARTIFACT_BYTES / 2 + 1) },
            ],
          ]);
        },
        textStep('Done.'),
      );
      const { reply } = await turn(chat.id, 'Write and edit');
      const errors = Object.fromEntries(
        reply.parts
          .filter((part) => part.type === 'tool-update_artifact')
          .map((part) => [part.toolCallId as string, [part.state, part.errorText]]),
      );
      expect(errors).toEqual({
        u1: ['output-error', 'No artifact with that id in this conversation.'],
        u2: ['output-error', 'Edit 1: the text to find was not found.'],
        u3: [
          'output-error',
          'Edit 1: the text to find occurs more than once; include more context.',
        ],
        u4: ['output-error', 'Send either `content` or `edits`, not both.'],
        u5: ['output-error', 'An artifact can be at most 512 KB.'],
      });
      const [artifact] = await artifactsOf(chat.id);
      expect(artifact!.currentVersion).toBe(1);
    });

    it('returns the existing artifact for a repeated call, and enforces version and count limits', async () => {
      const { chat, reply } = await seededReply('No blocks here.');
      const { createArtifact, addArtifactVersion } = await import(
        '../../services/artifacts/store.js'
      );
      const input = {
        userId: owner,
        role: 'user' as const,
        threadId: chat.id,
        messageId: reply.id,
        sourceKey: 'tool:repeat',
        title: '  ',
        kind: 'svg' as const,
        content: '<svg/>',
      };
      const first = await createArtifact(input);
      const again = await createArtifact({ ...input, content: '<svg>other</svg>' });
      expect(first).toMatchObject({ created: true, artifact: { title: 'SVG', sizeBytes: 6 } });
      expect(again).toMatchObject({ created: false, artifact: { id: first.artifact.id } });
      expect(await versionsOf(first.artifact.id)).toHaveLength(1);
      await expect(
        createArtifact({ ...input, sourceKey: 'tool:empty', content: ' ' }),
      ).rejects.toMatchObject({
        status: 422,
      });

      await pool.db
        .update(schema.artifact)
        .set({ currentVersion: 100 })
        .where(eq(schema.artifact.id, first.artifact.id));
      await expect(
        addArtifactVersion({
          artifactId: first.artifact.id,
          userId: owner,
          role: 'user',
          content: '<svg/>',
          source: 'reply',
          messageId: reply.id,
        }),
      ).rejects.toMatchObject({ status: 422 });

      await pool.db.execute(sql`
        insert into artifact (user_id, thread_id, message_id, source_key, title, kind)
        select ${owner}, ${chat.id}, ${reply.id}, 'tool:fill-' || n, 'Fill', 'svg'
        from generate_series(1, 199) as n
      `);
      await expect(createArtifact({ ...input, sourceKey: 'tool:one-more' })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('at most 200 artifacts'),
      });
      // Detected blocks beyond the limit stay code blocks.
      const { saveDetectedArtifacts } = await import('../../services/artifacts/store.js');
      expect(
        await saveDetectedArtifacts({
          userId: owner,
          role: 'user',
          threadId: chat.id,
          messageId: reply.id,
          parts: [{ type: 'text', text: `\`\`\`svg\n${SVG_IMAGE}\n\`\`\`` }],
        }),
      ).toBe(0);
    });

    it('cannot update another conversation’s or another person’s artifact', async () => {
      const mine = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``);
      const theirs = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``, stranger);
      const [own] = await artifactsOf(mine.chat.id);
      const [foreign] = await artifactsOf(theirs.chat.id);
      const chat = await thread();
      script(
        toolStep([
          ['u1', 'update_artifact', { artifactId: own!.id, content: '<svg/>' }],
          ['u2', 'update_artifact', { artifactId: foreign!.id, content: '<svg/>' }],
        ]),
        textStep('Done.'),
      );
      const { reply } = await turn(chat.id, 'Change them');
      expect(
        reply.parts
          .filter((part) => part.type === 'tool-update_artifact')
          .map((part) => part.state),
      ).toEqual(['output-error', 'output-error']);
      expect((await versionsOf(own!.id)).length).toBe(1);
      expect((await versionsOf(foreign!.id)).length).toBe(1);
    });
  });

  describe('versions API', () => {
    it('lists, reads and edits documents as new versions; HTML is changed through the model', async () => {
      const chat = await thread();
      script(
        toolStep([['c1', 'create_artifact', { title: 'Notes', kind: 'markdown', content: 'v1' }]]),
        textStep('Done.'),
      );
      await turn(chat.id, 'Notes please');
      const list = (await (await get(`/api/artifacts?threadId=${chat.id}`)).json()) as {
        artifacts: Array<{ id: string; currentVersion: number; sizeBytes: number }>;
      };
      expect(list.artifacts).toHaveLength(1);
      const id = list.artifacts[0]!.id;
      expect(list.artifacts[0]).toMatchObject({ currentVersion: 1, sizeBytes: 2 });

      const edited = await post(`/api/artifacts/${id}/versions`, {
        content: 'v2 by me',
        baseVersion: 1,
      });
      expect(edited.status).toBe(201);
      const stale = await post(`/api/artifacts/${id}/versions`, {
        content: 'v2 again',
        baseVersion: 1,
      });
      expect(stale.status).toBe(409);

      const detail = (await (await get(`/api/artifacts/${id}`)).json()) as {
        content: string;
        artifact: { currentVersion: number };
        versions: Array<{ version: number; source: string; messageId: string | null }>;
      };
      expect(detail.content).toBe('v2 by me');
      expect(detail.versions.map((version) => [version.version, version.source])).toEqual([
        [2, 'person'],
        [1, 'reply'],
      ]);
      expect(detail.versions[0]!.messageId).toBeNull();
      const first = (await (await get(`/api/artifacts/${id}/versions/1`)).json()) as {
        content: string;
      };
      expect(first.content).toBe('v1');
      expect((await get(`/api/artifacts/${id}/versions/9`)).status).toBe(404);
      expect((await get(`/api/artifacts/${id}/versions/abc`)).status).toBe(404);

      const page = await seededReply(`\`\`\`html\n${HTML_PAGE}\n\`\`\``);
      const [html] = await artifactsOf(page.chat.id);
      const refused = await post(`/api/artifacts/${html!.id}/versions`, {
        content: '<p>x</p>',
        baseVersion: 1,
      });
      expect(refused.status).toBe(422);
    });

    it('refuses edits when the role switch is off and oversize documents', async () => {
      const chat = await thread();
      script(
        toolStep([['c1', 'create_artifact', { title: 'Doc', kind: 'markdown', content: 'v1' }]]),
        textStep('Done.'),
      );
      await turn(chat.id, 'Doc');
      const [artifact] = await artifactsOf(chat.id);
      const big = await post(`/api/artifacts/${artifact!.id}/versions`, {
        content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1),
        baseVersion: 1,
      });
      expect(big.status).toBe(422);
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const off = await post(`/api/artifacts/${artifact!.id}/versions`, {
        content: 'v2',
        baseVersion: 1,
      });
      expect(off.status).toBe(403);
      // Reading stays possible: it is the person's own data.
      expect((await get(`/api/artifacts/${artifact!.id}`)).status).toBe(200);
    });

    it('returns 404 to everyone but the owner', async () => {
      const { chat } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      expect((await get(`/api/artifacts?threadId=${chat.id}`, stranger)).status).toBe(404);
      expect((await get(`/api/artifacts/${artifact!.id}`, stranger)).status).toBe(404);
      expect((await get(`/api/artifacts/${artifact!.id}/versions/1`, stranger)).status).toBe(404);
      expect(
        (
          await post(
            `/api/artifacts/${artifact!.id}/versions`,
            { content: 'x', baseVersion: 1 },
            stranger,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('storage', () => {
    it('counts artifact versions towards storage, except in the trash', async () => {
      const { getStorageUsage } = await import('../../services/storage/quota.js');
      const person = await seedUser(pool.db, state.organizationId);
      const { chat } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``, person);
      const bytes = Buffer.byteLength(SVG_IMAGE);
      expect(await getStorageUsage(person, 'user')).toMatchObject({
        liveBytes: bytes,
        artifactBytes: bytes,
        liveFileCount: 0,
        // Settings "Attachments" breaks the total down (v0.9.1).
        breakdown: {
          chatFiles: { bytes: 0, count: 0 },
          projectFiles: { bytes: 0, count: 0 },
          artifacts: { bytes, count: 1 },
        },
      });
      const { softDeleteThread, restoreThread } = await import('../../services/lifecycle/trash.js');
      await softDeleteThread(chat.id, person);
      expect((await getStorageUsage(person, 'user')).liveBytes).toBe(0);
      expect((await getStorageUsage(person, 'user')).breakdown?.artifacts).toEqual({
        bytes: 0,
        count: 0,
      });
      // Trashed conversations' artifacts are invisible.
      const [artifact] = await artifactsOf(chat.id);
      expect((await get(`/api/artifacts/${artifact!.id}`, person)).status).toBe(404);
      await restoreThread(chat.id, person);
      expect((await getStorageUsage(person, 'user')).liveBytes).toBe(bytes);
    });

    it('refuses an artifact that would exceed the storage allowance, and a restore that would', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      const chat = await thread(person);
      script(
        toolStep([
          ['c1', 'create_artifact', { title: 'Big', kind: 'markdown', content: 'x'.repeat(1_200) }],
        ]),
        textStep('Done.'),
      );
      const { reply } = await turn(chat.id, 'Big one', { user: person });
      const part = reply.parts.find((entry) => entry.type === 'tool-create_artifact');
      expect(part).toMatchObject({ state: 'output-error' });
      expect(String(part?.errorText)).toContain('storage limit');
      expect(await artifactsOf(chat.id)).toHaveLength(0);

      // Detected blocks over the allowance stay code blocks.
      const { chat: detected } = await seededReply(
        `\`\`\`svg\n<svg>${'y'.repeat(1_200)}</svg>\n\`\`\``,
        person,
      );
      expect(await artifactsOf(detected.id)).toHaveLength(0);

      // A restore that would put the person over the allowance is refused.
      await pool.db.execute(sql`delete from storage_policy`);
      const { chat: kept } = await seededReply(
        `\`\`\`svg\n<svg>${'z'.repeat(600)}</svg>\n\`\`\``,
        person,
      );
      const { softDeleteThread, restoreThread } = await import('../../services/lifecycle/trash.js');
      await softDeleteThread(kept.id, person);
      await seededReply(`\`\`\`svg\n<svg>${'w'.repeat(600)}</svg>\n\`\`\``, person);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      await expect(restoreThread(kept.id, person)).rejects.toMatchObject({ status: 422 });
    });

    it('includes artifacts in upload admission', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      await seededReply(`\`\`\`svg\n<svg>${'z'.repeat(900)}</svg>\n\`\`\``, person);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      state.settings.set('storage', {
        driver: 'local',
        maxFileBytes: 10_000_000,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain'],
      });
      const { uploadAttachment } = await import('../../services/attachments/upload.js');
      await expect(
        uploadAttachment({
          userId: person,
          role: 'user',
          filename: 'a.txt',
          declaredMimeType: 'text/plain',
          bytes: Buffer.from('x'.repeat(200)),
        }),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('storage limit') });
    });
  });

  describe('lifecycle', () => {
    it('goes with its conversation, its reply and its owner', async () => {
      const { chat } = await seededReply(REPLY);
      const artifacts = await artifactsOf(chat.id);
      expect(artifacts).toHaveLength(3);
      await pool.db.delete(schema.thread).where(eq(schema.thread.id, chat.id));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
      const [orphanVersions] = await pool.db.execute<{ count: number }>(
        sql`select count(*)::int as count from artifact_version where artifact_id in ${artifacts.map((artifact) => artifact.id)}`,
      );
      expect(orphanVersions?.count).toBe(0);

      const person = await seedUser(pool.db, state.organizationId);
      const { chat: theirs } = await seededReply(REPLY, person);
      await pool.db.delete(schema.user).where(eq(schema.user.id, person));
      expect(await artifactsOf(theirs.id)).toHaveLength(0);
    });

    it('is purged with a trashed conversation', async () => {
      const { chat } = await seededReply(REPLY);
      const { softDeleteThread, purgeTrashedThread } = await import(
        '../../services/lifecycle/trash.js'
      );
      await softDeleteThread(chat.id, owner);
      expect(await artifactsOf(chat.id)).toHaveLength(3);
      await purgeTrashedThread(chat.id, owner);
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });

    it('is removed by conversation retention', async () => {
      const { chat } = await seededReply(REPLY);
      await pool.db
        .update(schema.thread)
        .set({ lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })
        .where(eq(schema.thread.id, chat.id));
      state.settings.set('retention', { threadRetentionDays: 30, exemptPinnedThreads: true });
      const { applyThreadRetention } = await import('../../services/lifecycle/retention.js');
      const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
      expect(await applyThreadRetention()).toBeGreaterThan(0);
      // In the trash: kept, but no longer counted.
      expect(await artifactsOf(chat.id)).toHaveLength(3);
      await purgeExpiredTrash(new Date(Date.now() + 400 * 24 * 60 * 60 * 1000));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });

    it('is copied into forks with the versions made on the copied path', async () => {
      const { chat, reply } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      // A later reply, not part of a fork at the first reply, revises it.
      const [later] = await pool.db
        .insert(schema.message)
        .values({ threadId: chat.id, userId: owner, role: 'assistant', position: 3, parts: [] })
        .returning();
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: owner,
        role: 'user',
        content: '<svg><title>Later</title></svg>',
        source: 'reply',
        messageId: later!.id,
      });
      const response = await post(`/api/threads/${chat.id}/forks`, { messageId: reply.id });
      expect(response.status).toBe(201);
      const fork = ((await response.json()) as { thread: { id: string } }).thread;
      const [copy] = await artifactsOf(fork.id);
      expect(copy).toMatchObject({ sourceKey: 'block:0', kind: 'svg', currentVersion: 1 });
      expect(copy!.id).not.toBe(artifact!.id);
      const [copiedReply] = (await rows(fork.id)).filter((row) => row.role === 'assistant');
      expect(copy!.messageId).toBe(copiedReply!.id);
      expect((await versionsOf(copy!.id)).map((version) => version.content)).toEqual([SVG_IMAGE]);
    });
  });

  describe('exports and share links', () => {
    it('exports artifacts with every version in JSON and names them in Markdown', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const { chat, reply } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``, person);
      const [artifact] = await artifactsOf(chat.id);
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: person,
        role: 'user',
        content: '<svg><title>Two</title></svg>',
        source: 'reply',
        messageId: reply.id,
      });
      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id, person);
      expect(markdown).toContain('_Artifact \u201cDot\u201d (SVG, version 1)_');
      expect(markdown).toContain('_Artifact \u201cDot\u201d (SVG, version 2)_');

      const { exportArchive } = await import('../../services/portability/export-archive.js');
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportArchive({ id: person })) chunks.push(chunk);
      const files = unzipSync(Buffer.concat(chunks));
      const json = Object.entries(files).find(
        ([name]) => name.startsWith('conversations/') && name.endsWith('.json'),
      );
      const exported = JSON.parse(strFromU8(json![1])) as {
        artifacts: Array<{
          id: string;
          kind: string;
          versions: Array<{ version: number; content: string }>;
        }>;
      };
      expect(exported.artifacts).toEqual([
        expect.objectContaining({
          id: artifact!.id,
          kind: 'svg',
          currentVersion: 2,
          versions: [
            expect.objectContaining({ version: 1, content: SVG_IMAGE }),
            expect.objectContaining({ version: 2, content: '<svg><title>Two</title></svg>' }),
          ],
        }),
      ]);
    });

    it('shares artifacts at the shared version, redacted, and nothing from outside the share', async () => {
      const secret = 'api_key=sk-live-1234567890abcdefghijklmnop';
      const svg = `<svg><title>Keys</title><text>${secret}</text></svg>`;
      const { chat, reply } = await seededReply(`\`\`\`svg\n${svg}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      const { createShareLink, getPublicShare } = await import('../../services/share-links.js');
      const snapshot = await createShareLink(chat.id, owner, { upToMessageId: reply.id });
      // A later reply and a later person edit are not part of the snapshot.
      const [later] = await pool.db
        .insert(schema.message)
        .values({
          threadId: chat.id,
          userId: owner,
          role: 'assistant',
          position: 3,
          parts: [{ type: 'text', text: 'later' }],
        })
        .returning();
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: owner,
        role: 'user',
        content: '<svg><title>Later</title></svg>',
        source: 'reply',
        messageId: later!.id,
      });
      const shared = await getPublicShare(snapshot.slug);
      expect(shared.artifacts).toEqual([
        {
          messageId: reply.id,
          sourceKey: 'block:0',
          title: 'Keys',
          kind: 'svg',
          version: 1,
          content: expect.stringContaining('[REDACTED]'),
        },
      ]);
      expect(JSON.stringify(shared)).not.toContain('sk-live-1234567890');

      const liveLink = await createShareLink(chat.id, owner, {});
      const current = await getPublicShare(liveLink.slug);
      expect(current.artifacts[0]).toMatchObject({
        version: 2,
        content: '<svg><title>Later</title></svg>',
      });
    });
  });
});
