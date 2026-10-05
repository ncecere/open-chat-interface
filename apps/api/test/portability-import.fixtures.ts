import { rmSync } from 'node:fs';
import { sql } from '@oci/db';
import { strToU8, zipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  seedOrganization,
  seedUser,
} from './live-postgres.js';

/**
 * Shared setup for the live ChatGPT and Claude import suites
 * (portability-import-*.live.test.ts): small synthetic exports, shaped after
 * the documented quirks (branches, hidden nodes, null parts, split files,
 * content blocks and parent-linked message trees), and the hooks and request
 * helpers around the real upload route, job processing, PostgreSQL and local
 * storage.
 *
 * Each test file declares its own `vi.mock` block, hoisted `state` and storage
 * directory, and calls `usePortabilityImportSuite(state, storageRoot)` inside
 * its top-level `describe`.
 */
export interface PortabilityImportState {
  db: unknown;
  organizationId: string;
  runJobNow: ReturnType<typeof vi.fn<(name: string) => Promise<number>>>;
}

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
export const chatgptBranching = {
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

export const chatgptSimple = {
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

export const claudeV1 = {
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
export const claudeV2 = {
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
export function chatgptZip(options: { missingListed?: boolean } = {}) {
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

export interface PortabilityImportContext {
  live: LiveDatabase;
  userId: string;
  otherId: string;
}

/**
 * Registers the suite's hooks (a live database per file, imports and threads
 * cleared before each test, the storage directory removed afterwards) and
 * returns the helpers the tests use. Call inside the top-level describe.
 */
export function usePortabilityImportSuite(state: PortabilityImportState, storageRoot: string) {
  const ctx = {} as PortabilityImportContext;
  let routes: typeof import('../src/routes/portability.js')['portabilityRoutes'];
  let onError: typeof import('../src/middleware/error-handler.js')['errorHandler'];

  function appFor(userId: string) {
    const app = new Hono<AppBindings>();
    app.onError(onError);
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
    app.route('/api/me', routes);
    return app;
  }

  async function upload(userId: string, body: Buffer | string, filename = 'export.zip') {
    const form = new FormData();
    form.append(
      'file',
      new File([typeof body === 'string' ? body : new Uint8Array(body)], filename),
    );
    return appFor(userId).request('/api/me/imports', { method: 'POST', body: form });
  }

  beforeAll(async () => {
    ({ portabilityRoutes: routes } = await import('../src/routes/portability.js'));
    ({ errorHandler: onError } = await import('../src/middleware/error-handler.js'));
    const live = await createLiveDatabase('portability_import');
    ctx.live = live;
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ctx.userId = await seedUser(live.db, state.organizationId, { email: 'person@example.com' });
    ctx.otherId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });
  });

  beforeEach(async () => {
    state.runJobNow = vi.fn(async (_name: string) => 0);
    await ctx.live.db.execute(sql`delete from conversation_import`);
    await ctx.live.db.execute(sql`delete from thread`);
    await ctx.live.db.execute(sql`delete from storage_policy`);
  });

  afterAll(async () => {
    await ctx.live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function importsFor(id: string) {
    const response = await appFor(id).request('/api/me/imports');
    expect(response.status).toBe(200);
    return ((await response.json()) as { imports: Array<Record<string, unknown>> }).imports;
  }

  async function threadsFor(id: string) {
    return ctx.live.db.execute<{
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
    return ctx.live.db.execute<{
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

  return { ctx, appFor, upload, importsFor, threadsFor, messagesOf };
}
