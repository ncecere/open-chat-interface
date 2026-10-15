import { eq, schema, sql } from '@oci/db';
import type { ClassificationMode } from '@oci/shared';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { type ConnectorsState, useConnectorsSuite } from './connectors.fixtures.js';

/**
 * Shared setup for the data classification suites (classification-*.live.test.ts,
 * #395): the connectors suite's database, MCP server, scripted model and routes,
 * plus the project, thread and share routes, two catalog models to approve, and
 * helpers that define classes and label things through the real HTTP API.
 *
 * Each test file declares its own `vi.mock` block and hoisted `state`, and calls
 * `useClassificationSuite(state)` inside its top-level `describe`.
 */
export interface ClassificationState extends ConnectorsState {
  /** Capabilities `resolveModelForRole` reports (no `tool_calling`: up-front search). */
  capabilities: string[];
}

/** Slugs of the two seeded catalog models. */
export const UNAPPROVED_MODEL = 'tool-model';
export const APPROVED_MODEL = 'approved-model';

export function useClassificationSuite(state: ClassificationState) {
  const base = useConnectorsSuite(state);
  const { ctx, call, ok } = base;
  const models = new Map<string, string>();

  beforeAll(async () => {
    const { threadRoutes } = await import('../src/routes/threads.js');
    const { projectRoutes } = await import('../src/routes/projects.js');
    const { shareLinkRoutes } = await import('../src/routes/share-links.js');
    ctx.app.route('/api/threads', threadRoutes);
    ctx.app.route('/api/projects', projectRoutes);
    ctx.app.route('/api/share', shareLinkRoutes);
    const [provider] = await ctx.pool.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai-compatible', label: 'Fake' })
      .returning();
    for (const [slug, displayName] of [
      [UNAPPROVED_MODEL, 'Tool Model'],
      [APPROVED_MODEL, 'Approved Model'],
    ] as const) {
      const [row] = await ctx.pool.db
        .insert(schema.model)
        .values({
          organizationId: state.organizationId,
          providerId: provider!.id,
          slug,
          displayName,
          upstreamModelId: slug,
          capabilities: ['tool_calling'],
        })
        .returning();
      models.set(slug, row!.id);
    }
  });
  beforeEach(() => {
    state.capabilities = ['tool_calling'];
  });
  // Declared after the connectors suite's hook, so it runs first: classes are
  // restricted by their labels, which go with the threads, projects and
  // connectors, and then the classes themselves.
  afterEach(async () => {
    await ctx.pool.db.execute(
      sql`update message set status = 'complete' where status = 'streaming'`,
    );
    await ctx.pool.db.execute(sql`delete from thread`);
    await ctx.pool.db.execute(sql`delete from project`);
    await ctx.pool.db.execute(sql`delete from connector`);
    await ctx.pool.db.execute(sql`delete from data_class`);
    await ctx.pool.db.execute(sql`delete from audit_log`);
  });

  /**
   * A scripted model. A step may be a function, run when the provider is called
   * (to change something mid-turn, or to see what the model was sent).
   */
  function script(...steps: unknown[]) {
    let next = 0;
    const model = new MockLanguageModelV4({
      doStream: (async () => {
        const step = steps[next++];
        if (!step) throw new Error('The scripted model has no more steps');
        return typeof step === 'function' ? await step() : step;
      }) as never,
    });
    state.model = model;
    return model;
  }

  /** Defines a class through the admin API; returns its id and name. */
  async function createClass(name: string, description = '') {
    return ok<{ id: string; name: string }>(
      call('POST', '/api/admin/data-classes', { body: { name, description } }),
      201,
    );
  }
  async function approve(slug: string, classIds: string[]) {
    await ok(
      call('PUT', `/api/admin/models/${models.get(slug)}/data-classes`, { body: { classIds } }),
    );
  }
  /** What a connector carries; `reviewed` says it was looked at (even if it carries nothing). */
  async function carry(connector: { id: string }, classIds: string[], reviewed = true) {
    await ok(
      call('PUT', `/api/admin/connectors/${connector.id}/data-classes`, {
        body: { classIds, reviewed },
      }),
    );
  }
  /** The mode and service approvals, as the setting holds them. */
  function setMode(
    mode: ClassificationMode,
    services: Partial<Record<'webSearch' | 'embeddings' | 'reranking', string[]>> = {},
  ) {
    state.settings.set('classification', {
      mode,
      services: { webSearch: [], embeddings: [], reranking: [], ...services },
    });
  }
  async function createProject(user: string, name = 'Records') {
    const { project } = await ok<{ project: { id: string } }>(
      call('POST', '/api/projects', { user, body: { name } }),
      201,
    );
    return project;
  }
  async function labelProject(user: string, projectId: string, classIds: string[]) {
    await ok(call('PUT', `/api/projects/${projectId}/data-classes`, { user, body: { classIds } }));
  }
  async function labelThread(user: string, threadId: string, classId: string) {
    return call('POST', `/api/threads/${threadId}/data-classes`, { user, body: { classId } });
  }
  async function projectThread(user: string, projectId: string) {
    const { thread } = await ok<{ thread: { id: string } }>(
      call('POST', '/api/threads', { user, body: { title: 'Case notes', projectId } }),
      201,
    );
    return thread;
  }
  /** A send, as the composer posts it. The response is not read. */
  function send(
    user: string,
    threadId: string,
    text: string,
    options: { modelSlug?: string; webSearch?: boolean } = {},
  ) {
    return ctx.app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({
        threadId,
        modelSlug: options.modelSlug ?? UNAPPROVED_MODEL,
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: options.webSearch ?? false,
      }),
    });
  }
  /** A send that is expected to be refused with DATA_CLASS_BLOCKED. */
  async function blocked(response: Response) {
    const text = await response.text();
    expect(response.status, text).toBe(403);
    const body = JSON.parse(text) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe('DATA_CLASS_BLOCKED');
    return body.error;
  }
  /** Sends, expects it to be accepted, and waits for the reply to be stored. */
  async function accepted(response: Response, threadId: string) {
    expect(response.status, await response.clone().text()).toBe(200);
    await response.text();
    return base.settled(threadId);
  }
  /** Provider calls the scripted model has received. */
  const providerCalls = () =>
    (state.model as { doStreamCalls: unknown[] } | null)?.doStreamCalls.length ?? 0;
  async function messageCount(threadId: string) {
    return (await base.rows(threadId)).length;
  }
  async function auditsOf(action: string) {
    return ctx.pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }

  return {
    ...base,
    script,
    models,
    createClass,
    approve,
    carry,
    setMode,
    createProject,
    labelProject,
    labelThread,
    projectThread,
    send,
    blocked,
    accepted,
    providerCalls,
    messageCount,
    auditsOf,
  };
}
