import { type createDatabase, eq, schema } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared by the chat-tools*.live.test.ts suites: a scripted model in place of
 * a provider, the chat and admin role routes, and helpers that send turns and
 * answer approvals. Each suite declares its own mocks and creates its own
 * database.
 */

export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
export function toolStep(
  calls: Array<[id: string, tool: string, input: unknown]>,
  [input, output]: [number, number] = [10, 5],
) {
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
        usage: usage(input, output),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      },
    ]),
  };
}
export function textStep(text: string, [input, output]: [number, number] = [20, 7]) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't' },
      { type: 'text-delta' as const, id: 't', delta: text },
      { type: 'text-end' as const, id: 't' },
      {
        type: 'finish' as const,
        usage: usage(input, output),
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      },
    ]),
  };
}
/** A step that starts and then waits until the run is stopped. */
export function hangingStep(started: () => void) {
  return (options: { abortSignal?: AbortSignal }) => {
    started();
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          // As a provider's fetch does when the run is stopped.
          options.abortSignal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      }),
    };
  };
}

/** Returns `script` bound to a suite's hoisted mock state. */
export function scriptFor(state: { model: unknown }) {
  return function script(...steps: unknown[]) {
    let next = 0;
    const model = new MockLanguageModelV4({
      doStream: (async (options: { abortSignal?: AbortSignal }) => {
        const step = steps[next++];
        if (!step) throw new Error('The scripted model has no more steps');
        return typeof step === 'function' ? step(options) : step;
      }) as never,
    });
    state.model = model;
    return model;
  };
}

/** Tool names offered on one provider call. */
export const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();

/** The chat and admin role routes, as `x-test-user`/`x-test-role` or else the owner. */
export async function toolsApp(organizationId: string, owner: string) {
  const { chatRoutes } = await import('../src/routes/chat.js');
  const { rolesRoutes } = await import('../src/routes/admin/roles.js');
  const { errorHandler } = await import('../src/middleware/error-handler.js');
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-test-user') ?? owner,
      name: 'Test',
      email: 'test@example.test',
      image: null,
      role: (c.req.header('x-test-role') as 'user') ?? 'user',
      emailVerified: true,
      organizationId,
    });
    await next();
  });
  app.route('/api/chat', chatRoutes);
  app.route('/api/admin/roles', rolesRoutes);
  return app;
}

/** What the helpers need from a suite; read when a helper runs, after `beforeAll`. */
export interface ToolsSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly app: Hono<AppBindings>;
  readonly owner: string;
  readonly organizationId: string;
}

export function toolsHelpers(suite: ToolsSuite, script: ReturnType<typeof scriptFor>) {
  async function thread(user = suite.owner) {
    const [row] = await suite.pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: suite.organizationId, title: 'Tools chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return suite.pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
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
  async function send(
    threadId: string,
    text: string,
    options: { webSearch?: boolean; role?: string; user?: string } = {},
  ) {
    return suite.app.request('/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.role ? { 'x-test-role': options.role } : {}),
        ...(options.user ? { 'x-test-user': options.user } : {}),
      },
      body: JSON.stringify({
        threadId,
        modelSlug: 'tool-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: options.webSearch ?? true,
      }),
    });
  }
  /** Sends and waits for the reply to be stored. */
  async function turn(threadId: string, text: string, options: Parameters<typeof send>[2] = {}) {
    const response = await send(threadId, text, options);
    expect(response.status).toBe(200);
    const body = await response.text();
    const stored = await settled(threadId);
    return { body, reply: stored.at(-1)!, stored };
  }
  function answer(
    threadId: string,
    messageId: string,
    responses: Array<{ approvalId: string; approved: boolean }>,
    user = suite.owner,
  ) {
    return suite.app.request(`/api/chat/${threadId}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({ messageId, responses }),
    });
  }
  const toolParts = (parts: Record<string, unknown>[]) =>
    parts.filter((part) => String(part.type).startsWith('tool-') || part.type === 'dynamic-tool');
  const approvalIdOf = (parts: Record<string, unknown>[]) => {
    const pending = toolParts(parts).find((part) => part.state === 'approval-requested');
    return (pending?.approval as { id: string } | undefined)?.id ?? '';
  };
  async function toolAudits() {
    return suite.pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'tool.call'))
      .orderBy(schema.auditLog.createdAt);
  }
  async function awaitingApproval(user = suite.owner) {
    const chat = await thread(user);
    script(toolStep([['w1', 'send_note', { to: 'Ada' }]]), textStep('Done.'), textStep('Unused'));
    const { reply } = await turn(chat.id, 'Send Ada a note', { webSearch: false, user });
    return { chat, reply, approvalId: approvalIdOf(reply.parts) };
  }

  return {
    thread,
    rows,
    settled,
    send,
    turn,
    answer,
    toolParts,
    approvalIdOf,
    toolAudits,
    awaitingApproval,
  };
}
