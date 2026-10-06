import { createDatabase, eq, runPostMigrations, schema, sql } from '@oci/db';
import { MAX_ARTIFACT_BYTES } from '@oci/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  offered,
  SVG_IMAGE,
  systemOf,
  textStep,
  toolStep,
} from '../../../test/artifacts.fixtures.js';
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
 * This suite covers the create_artifact and update_artifact tools and their guidance; the shared fixtures live in
 * test/artifacts.fixtures.ts.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: ['tool_calling'] as string[],
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  // Post-deploy readiness (code artifacts, #298) reads it.
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

const script = createScript(state);

describe.skipIf(!available)('live artifacts', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('artifacts_tools');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    app = await buildArtifactsApp(state, () => owner);
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

  const { artifactsOf, seededReply, thread, turn, versionsOf } = artifactHelpers(state, () => ({
    pool,
    owner,
    app,
  }));

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
        'Program code goes in fenced code blocks in your reply',
      );
    });

    it('saves code asked for as an artifact as code in its language, not an HTML page (#298)', async () => {
      const { CODE_ARTIFACTS, CODE_ARTIFACTS_WITHOUT_TOOLS } = await import(
        '../../services/artifacts/guidance.js'
      );
      const { CODE_ARTIFACT_NOT_YET, CODE_ARTIFACT_REFUSAL } = await import(
        '../../services/tools/artifacts.js'
      );
      const { resetReadinessCache } = await import('../../services/migrations/readiness.js');
      // What the QA walk asked for; the usage line was dropped from an HTML page.
      const code = [
        'import csv',
        'import sys',
        '',
        'if len(sys.argv) < 2:',
        '    print("Usage: python inventory.py <inventory.csv> [threshold]")',
      ].join('\n');
      const call = (): Array<[string, string, unknown]> => [
        [
          'c1',
          'create_artifact',
          { title: 'Walk6 inventory script', kind: 'code', language: 'py', content: code },
        ],
      ];
      const ask =
        'Walk6 GW code: create a Code artifact titled Walk6 inventory script: a Python script that reads a CSV.';

      // During a rolling upgrade (post-deploy step 0009 not run), the previous
      // release's web app may still open the conversation and cannot draw a
      // code artifact's card: code stays in the reply.
      resetReadinessCache();
      const early = await thread();
      const before = script(toolStep(call()), textStep('Here it is.'));
      const { reply: declined } = await turn(early.id, ask);
      expect(systemOf(before)).toContain(CODE_ARTIFACTS_WITHOUT_TOOLS);
      expect(systemOf(before)).not.toContain(CODE_ARTIFACTS);
      expect(declined.parts.find((part) => part.type === 'tool-create_artifact')?.output).toEqual({
        saved: false,
        note: CODE_ARTIFACT_NOT_YET,
      });
      expect(await artifactsOf(early.id)).toEqual([]);

      await runPostMigrations(live.connectionString, {
        logger: { info: () => {}, warn: () => {} },
        backgroundMigrations: [],
      });
      resetReadinessCache();
      const chat = await thread();
      const model = script(toolStep(call()), textStep('Saved.'));
      await turn(chat.id, ask);
      expect(systemOf(model)).toContain(CODE_ARTIFACTS);
      const tool = (model.doStreamCalls[0]?.tools ?? []).find(
        (entry) => 'name' in entry && entry.name === 'create_artifact',
      );
      expect(tool && 'description' in tool ? tool.description : '').toContain(
        'save it as kind code with its language',
      );
      const [artifact] = await artifactsOf(chat.id);
      expect(artifact).toMatchObject({
        kind: 'code',
        language: 'python',
        title: 'Walk6 inventory script',
      });
      expect((await versionsOf(artifact!.id)).map((version) => version.content)).toEqual([code]);
      // The conversation's list and the artifact itself carry the language.
      const listed = (await (
        await app.request(`/api/artifacts?threadId=${chat.id}`, {
          headers: { 'x-test-user': owner },
        })
      ).json()) as { artifacts: Array<{ kind: string; language: string | null }> };
      expect(listed.artifacts).toMatchObject([{ kind: 'code', language: 'python' }]);
      const { exportThreadMarkdown } = await import('../../services/export.js');
      expect(await exportThreadMarkdown(chat.id, owner)).toContain(
        '\u201cWalk6 inventory script\u201d (Python, version 1',
      );
      // A fork keeps it.
      const forked = (await (
        await app.request(`/api/threads/${chat.id}/forks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-user': owner },
          body: JSON.stringify({ messageId: artifact!.messageId }),
        })
      ).json()) as { thread: { id: string } };
      expect(await artifactsOf(forked.thread.id)).toMatchObject([
        { kind: 'code', language: 'python' },
      ]);

      // Not asked for: code stays in the reply (#149).
      const unasked = await thread();
      script(toolStep(call()), textStep('Here it is.'));
      const { reply } = await turn(unasked.id, 'Write a Python script that reads a CSV.');
      expect(reply.parts.find((part) => part.type === 'tool-create_artifact')?.output).toEqual({
        saved: false,
        note: CODE_ARTIFACT_REFUSAL,
      });
      expect(await artifactsOf(unasked.id)).toEqual([]);
    });

    it('offers no artifact tools, and says artifacts are unavailable, when the role switch is off', async () => {
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Create a Document artifact titled Walk5 RM doc.');
      expect(offered(model)).toEqual([]);
      // Told so, rather than left to claim it made one (#277).
      const { NO_ARTIFACTS } = await import('../../services/artifacts/guidance.js');
      expect(systemOf(model)).toContain('never say you created, saved or attached');
      expect(systemOf(model)).toContain(NO_ARTIFACTS);
      expect(systemOf(model)).not.toContain('create_artifact');
      expect(systemOf(model)).not.toContain('fenced code block (```html');
      expect(systemOf(model)).not.toContain('Diagram Design');
    });

    it('draws diagrams in the colour theme when no accent colour is set (v0.10)', async () => {
      state.settings.set('branding', { colorTheme: 'violet', accentColor: null });
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Hi');
      expect(systemOf(model)).toContain('Use the accent #7f22fe');
      expect(systemOf(model)).not.toContain('#eb6c36');
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
      // Short, so it is saved only because the person asked for an artifact (#149).
      const created = await turn(chat.id, 'Write a plan as an artifact');
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
      const { reply } = await turn(chat.id, 'Write an artifact and edit it');
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

    it('keeps a small table and a function out of Markdown artifacts unless asked (#149, #201)', async () => {
      const {
        CODE_MARKDOWN_REFUSAL,
        MIN_MARKDOWN_ARTIFACT_CHARS,
        SHORT_MARKDOWN_REFUSAL,
        isDeclinedArtifactPart,
        toolStepsOf,
      } = await import('@oci/shared');
      // What the instance's default model sent in the QA walk.
      const table = [
        '| Planet | Diameter (km) |',
        '| --- | --- |',
        '| Mercury | 4,879 |',
        '| Venus | 12,104 |',
        '| Earth | 12,742 |',
      ].join('\n');
      const code = '```python\ndef add(a, b):\n    """Add two numbers."""\n    return a + b\n```';
      const report = `# Report\n\n${'A sentence of the report that runs on. '.repeat(20)}`;
      expect(report.length).toBeGreaterThan(MIN_MARKDOWN_ARTIFACT_CHARS);
      const calls = (): Array<[string, string, unknown]> => [
        ['c1', 'create_artifact', { title: 'Planets', kind: 'markdown', content: table }],
        ['c2', 'create_artifact', { title: 'Add', kind: 'markdown', content: code }],
        ['c3', 'create_artifact', { title: 'Report', kind: 'markdown', content: report }],
        ['c4', 'create_artifact', { title: 'Dot', kind: 'svg', content: SVG_IMAGE }],
      ];
      const chat = await thread();
      script(toolStep(calls()), textStep('Here they are.'));
      const { reply } = await turn(
        chat.id,
        'give me a 3-row Markdown table of planets with diameter in km, then a short Python function that adds two numbers',
      );
      const outcomes = Object.fromEntries(
        reply.parts
          .filter((part) => part.type === 'tool-create_artifact')
          .map((part) => [
            part.toolCallId as string,
            [part.state, part.errorText ?? null, (part.output as { note?: string })?.note ?? null],
          ]),
      );
      // Declined, not failed (#201): the model reads why in the result.
      expect(outcomes).toEqual({
        c1: ['output-available', null, SHORT_MARKDOWN_REFUSAL],
        c2: ['output-available', null, CODE_MARKDOWN_REFUSAL],
        c3: ['output-available', null, null],
        c4: ['output-available', null, null],
      });
      // The stored reply's steps, as every renderer lists them, leave them out.
      expect(reply.parts.filter(isDeclinedArtifactPart).map((part) => part.toolCallId)).toEqual([
        'c1',
        'c2',
      ]);
      expect(toolStepsOf(reply.parts).map((step) => step.summary)).toEqual([
        "Created artifact 'Report'",
        "Created artifact 'Dot'",
      ]);
      expect((await artifactsOf(chat.id)).map((artifact) => artifact.title).sort()).toEqual([
        'Dot',
        'Report',
      ]);

      // Asked for by name, the same content is saved.
      const asked = await thread();
      script(toolStep(calls().slice(0, 2)), textStep('Done.'));
      await turn(asked.id, 'Put the planets table and the function in artifacts');
      expect((await artifactsOf(asked.id)).map((artifact) => artifact.title).sort()).toEqual([
        'Add',
        'Planets',
      ]);
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
});
