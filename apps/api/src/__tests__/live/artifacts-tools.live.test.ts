import { createDatabase, runPostMigrations, sql } from '@oci/db';
import { MAX_ARTIFACT_BYTES } from '@oci/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  offered,
  PLANETS_PAGE,
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
      // What Claude Haiku 4.5 (thinking) saved as a Document (#313): over 500
      // characters outside code, but most of them table, markup and a URL.
      const owls = [
        '## Owls and Code\n\n| Name | Wingspan | Region |\n| --- | --- | --- |',
        '| Great Horned Owl | 101 to 145 centimetres | North and South America |',
        '| Snowy Owl | 125 to 150 centimetres | Arctic tundra of the north |',
        '| Barn Owl | 80 to 95 centimetres | Nearly worldwide, every continent |\n',
        '```python\ndef wingspan_m(cm):\n    return cm / 100\n```\n',
        '1. Owls can turn their heads about 270 degrees.\n2. Their feathers make flight silent.',
        '3. Many species hunt mostly at night.\n\nThe owl looks out over the silent wood,',
        'and waits for night as every hunter should.\n\nRead more at [Example](https://example.com).',
      ].join('\n');
      expect(owls.replace(/```[\s\S]*?```/, '').trim().length).toBeGreaterThan(
        MIN_MARKDOWN_ARTIFACT_CHARS,
      );
      const report = `# Report\n\n${'A sentence of the report that runs on. '.repeat(20)}`;
      expect(report.length).toBeGreaterThan(MIN_MARKDOWN_ARTIFACT_CHARS);
      const calls = (): Array<[string, string, unknown]> => [
        ['c1', 'create_artifact', { title: 'Planets', kind: 'markdown', content: table }],
        ['c2', 'create_artifact', { title: 'Add', kind: 'markdown', content: code }],
        ['c3', 'create_artifact', { title: 'Report', kind: 'markdown', content: report }],
        ['c4', 'create_artifact', { title: 'Dot', kind: 'svg', content: SVG_IMAGE }],
        ['c5', 'create_artifact', { title: 'Owls', kind: 'markdown', content: owls }],
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
        c5: ['output-available', null, SHORT_MARKDOWN_REFUSAL],
      });
      // The stored reply's steps, as every renderer lists them, leave them out.
      expect(reply.parts.filter(isDeclinedArtifactPart).map((part) => part.toolCallId)).toEqual([
        'c1',
        'c2',
        'c5',
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
      script(toolStep(calls().filter(([id]) => id !== 'c3' && id !== 'c4')), textStep('Done.'));
      await turn(asked.id, 'Put the planets table and the function in artifacts');
      expect((await artifactsOf(asked.id)).map((artifact) => artifact.title).sort()).toEqual([
        'Add',
        'Owls',
        'Planets',
      ]);
    });

    it('keeps a short static HTML page out of artifacts unless asked, not an app or a long page (#313)', async () => {
      const { SHORT_HTML_REFUSAL, isDeclinedArtifactPart, toolStepsOf } = await import(
        '@oci/shared'
      );
      const { TABLES_IN_CHAT } = await import('../../services/artifacts/guidance.js');
      // Sorted by a click: interactive, so kept however short.
      const sortable = PLANETS_PAGE.replace(
        '</body>',
        '<script>document.querySelector("th").onclick = () => {};</script>\n</body>',
      );
      const guide = `<!doctype html><html><body><h1>Guide</h1>${'<p>A sentence of the guide that runs on.</p>'.repeat(20)}</body></html>`;
      const calls = (): Array<[string, string, unknown]> => [
        ['h1', 'create_artifact', { title: 'Planets', kind: 'html', content: PLANETS_PAGE }],
        ['h2', 'create_artifact', { title: 'Sortable', kind: 'html', content: sortable }],
        ['h3', 'create_artifact', { title: 'Guide', kind: 'html', content: guide }],
      ];
      const chat = await thread();
      const model = script(toolStep(calls()), textStep('Here they are.'));
      const { reply } = await turn(
        chat.id,
        'Fix7 313: a small table of three planets and their moons',
      );
      const outcomes = Object.fromEntries(
        reply.parts
          .filter((part) => part.type === 'tool-create_artifact')
          .map((part) => [
            part.toolCallId as string,
            [part.state, (part.output as { note?: string })?.note ?? null],
          ]),
      );
      // Declined as the short Markdown table is (#149, #201): the model reads why.
      expect(outcomes).toEqual({
        h1: ['output-available', SHORT_HTML_REFUSAL],
        h2: ['output-available', null],
        h3: ['output-available', null],
      });
      expect(reply.parts.filter(isDeclinedArtifactPart).map((part) => part.toolCallId)).toEqual([
        'h1',
      ]);
      expect(toolStepsOf(reply.parts).map((step) => step.summary)).toEqual([
        "Created artifact 'Sortable'",
        "Created artifact 'Guide'",
      ]);
      expect((await artifactsOf(chat.id)).map((artifact) => artifact.title).sort()).toEqual([
        'Guide',
        'Sortable',
      ]);
      // And the model is told to write a simple table in its reply as Markdown.
      expect(systemOf(model)).toContain(TABLES_IN_CHAT);

      // Asked for by name, the same table is saved.
      const asked = await thread();
      script(toolStep(calls().slice(0, 1)), textStep('Done.'));
      await turn(asked.id, 'Fix7 313: the planets table as an HTML artifact');
      expect((await artifactsOf(asked.id)).map((artifact) => artifact.title)).toEqual(['Planets']);
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
