import { type createDatabase, eq, schema } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared fixtures for the live artifact suites (artifacts-*.live.test.ts):
 * a scripted model, the reply fixtures, the app under test and helpers over
 * the conversation, message and artifact tables. Each suite declares its own
 * `vi.mock` block and `state`, and passes the state in here.
 */
export interface ArtifactsState {
  db: unknown;
  organizationId: string;
  model: unknown;
  capabilities: string[];
  settings: Map<string, unknown>;
}

type Pool = ReturnType<typeof createDatabase>;

export interface ArtifactsContext {
  pool: Pool;
  owner: string;
  app: Hono<AppBindings>;
}

export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
export function toolStep(calls: Array<[id: string, tool: string, input: unknown]>) {
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
export function textStep(text: string) {
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
/** Returns `script(...steps)`, which installs a scripted model in `state.model`. */
export function createScript(state: Pick<ArtifactsState, 'model'>) {
  return function script(...steps: unknown[]) {
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
  };
}
export const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();
export const systemOf = (model: MockLanguageModelV4, call = 0) =>
  JSON.stringify(
    ((model.doStreamCalls[call]?.prompt ?? []) as Array<{ role: string; content: unknown }>).filter(
      (message) => message.role === 'system',
    ),
  );

export const HTML_PAGE = [
  '<!doctype html>',
  '<html><head><title>Sales &amp; chart</title></head>',
  '<body><h1>Sales</h1><script data-oci-library="d3"></script></body></html>',
].join('\n');
export const SVG_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Dot</title><circle r="4" cx="5" cy="5"/></svg>';
export const MERMAID = 'flowchart LR\n  A[Start] --> B[Middle]\n  B --> C[End]';
export const REPLY = [
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

/** The real chat, artifact and thread routes behind a test session. */
export async function buildArtifactsApp(state: ArtifactsState, owner: () => string) {
  const { chatRoutes } = await import('../src/routes/chat.js');
  const { artifactRoutes } = await import('../src/routes/artifacts.js');
  const { threadRoutes } = await import('../src/routes/threads.js');
  const { errorHandler } = await import('../src/middleware/error-handler.js');
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-test-user') ?? owner(),
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
  return app;
}

/** Helpers over the live database and app; `context` is read when each is called. */
export function artifactHelpers(state: ArtifactsState, context: () => ArtifactsContext) {
  async function thread(user = context().owner) {
    const [row] = await context()
      .pool.db.insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Artifacts chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return context()
      .pool.db.select()
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
    const response = await context().app.request('/api/chat', {
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
    return context()
      .pool.db.select()
      .from(schema.artifact)
      .where(eq(schema.artifact.threadId, threadId))
      .orderBy(schema.artifact.createdAt, schema.artifact.sourceKey);
  }
  async function versionsOf(artifactId: string) {
    return context()
      .pool.db.select()
      .from(schema.artifactVersion)
      .where(eq(schema.artifactVersion.artifactId, artifactId))
      .orderBy(schema.artifactVersion.version);
  }
  function get(path: string, user = context().owner) {
    return context().app.request(path, { headers: { 'x-test-user': user } });
  }
  function post(path: string, body: unknown, user = context().owner) {
    return context().app.request(path, {
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
  async function seededReply(text: string, user = context().owner) {
    const chat = await thread(user);
    const [prompt, reply] = await context()
      .pool.db.insert(schema.message)
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
    const { saveDetectedArtifacts } = await import('../src/services/artifacts/store.js');
    await saveDetectedArtifacts({
      userId: user,
      role: 'user',
      threadId: chat.id,
      messageId: reply!.id,
      parts: reply!.parts,
    });
    return { chat, prompt: prompt!, reply: reply! };
  }
  return {
    thread,
    rows,
    settled,
    turn,
    artifactsOf,
    versionsOf,
    get,
    post,
    waitForArtifacts,
    seededReply,
  };
}
