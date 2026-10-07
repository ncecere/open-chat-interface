import { type createDatabase, eq, schema, sql } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared fixtures for the live user memory suites (memory-*.live.test.ts): a
 * scripted model, the app under test and helpers over preferences, threads,
 * memories, messages, the memory API and the audit log. Each suite declares
 * its own `vi.mock` block and `state`, and passes the state in here.
 */
export interface MemoryState {
  db: unknown;
  organizationId: string;
  model: unknown;
  capabilities: string[];
  settings: Map<string, unknown>;
}

type Pool = ReturnType<typeof createDatabase>;

export interface MemoryContext {
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
export function createScript(state: Pick<MemoryState, 'model'>) {
  return function script(...steps: unknown[]) {
    let next = 0;
    const model = new MockLanguageModelV4({
      doStream: (async () => {
        const step = steps[next++];
        if (!step) throw new Error('The scripted model has no more steps');
        return step;
      }) as never,
    });
    state.model = model;
    return model;
  };
}
/** The memory tools offered on one provider call; other built-in tools (artifacts) are ignored. */
export const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? [])
    .map((tool) => ('name' in tool ? tool.name : ''))
    .filter((name) => name === 'remember' || name === 'forget')
    .sort();
/** The system prompt sent on one provider call. */
export function systemOf(model: MockLanguageModelV4, call = 0): string {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');
}

/** The real chat and memory routes behind a test session. */
export async function buildMemoryApp(state: MemoryState, owner: () => string) {
  const { chatRoutes } = await import('../src/routes/chat.js');
  const { memoryRoutes } = await import('../src/routes/memory.js');
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
  app.route('/api/memory', memoryRoutes);
  return app;
}

/** Helpers over the live database and app; `context` is read when each is called. */
export function memoryHelpers(state: MemoryState, context: () => MemoryContext) {
  async function optIn(userId: string, enabled: boolean) {
    await context()
      .pool.db.insert(schema.userPreference)
      .values({ userId, memoryEnabled: enabled })
      .onConflictDoUpdate({
        target: schema.userPreference.userId,
        set: { memoryEnabled: enabled },
      });
  }
  async function thread(user = context().owner, temporary = false) {
    const [row] = await context()
      .pool.db.insert(schema.thread)
      .values({
        userId: user,
        organizationId: state.organizationId,
        title: 'Memory chat',
        temporary,
        ...(temporary ? { expiresAt: new Date(Date.now() + 86_400_000) } : {}),
      })
      .returning();
    return row!;
  }
  async function seedMemory(
    content: string,
    options: { user?: string; updatedAt?: Date; source?: 'tool' | 'person' } = {},
  ) {
    const at = options.updatedAt ?? new Date();
    const [row] = await context()
      .pool.db.insert(schema.userMemory)
      .values({
        userId: options.user ?? context().owner,
        content,
        source: options.source ?? 'person',
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return row!;
  }
  async function memories(user = context().owner) {
    return context()
      .pool.db.select()
      .from(schema.userMemory)
      .where(eq(schema.userMemory.userId, user))
      .orderBy(schema.userMemory.createdAt);
  }
  async function rows(threadId: string) {
    return context()
      .pool.db.select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function turn(
    threadId: string,
    text: string,
    options: { role?: string; user?: string; temporary?: boolean } = {},
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
        modelSlug: 'tool-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: false,
        temporary: options.temporary ?? false,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await response.text();
    await vi.waitFor(
      async () => {
        const stored = await rows(threadId);
        expect(stored.some((row) => row.status === 'streaming')).toBe(false);
      },
      { timeout: 5_000, interval: 20 },
    );
    const stored = await rows(threadId);
    return { reply: stored.at(-1)!, stored };
  }
  const toolParts = (parts: Record<string, unknown>[]) =>
    parts.filter((part) => String(part.type).startsWith('tool-'));
  function call(
    method: string,
    path: string,
    body?: unknown,
    user = context().owner,
    role = 'user',
  ) {
    return context().app.request(`/api/memory${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-role': role },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function audits() {
    return context()
      .pool.db.select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} like 'memory.%'`)
      .orderBy(schema.auditLog.createdAt);
  }
  return { optIn, thread, seedMemory, memories, rows, turn, toolParts, call, audits };
}
