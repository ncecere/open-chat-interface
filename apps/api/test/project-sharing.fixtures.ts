import { randomUUID } from 'node:crypto';
import { type Database, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared helpers for the project-sharing live suites (project-sharing-*.live.test.ts
 * and project-owner-parity): people, the app under test, the real sharing routes,
 * files and groups. Each suite declares its own `vi.mock` block and `state`,
 * imports the routes after its mocks, and passes both in here. Seeds that are not
 * the thing under test go straight into the tables; the thing under test goes
 * through the real routes.
 */
export interface SharingState {
  organizationId: string;
  /** The role every request is made with unless a person has their own. */
  role: string;
}

export interface SharingDependencies {
  state: SharingState;
  routes: {
    projectRoutes: typeof import('../src/routes/projects.js').projectRoutes;
    threadRoutes: typeof import('../src/routes/threads.js').threadRoutes;
    attachmentRoutes: typeof import('../src/routes/attachments.js').attachmentRoutes;
  };
  errorHandler: typeof import('../src/middleware/error-handler.js').errorHandler;
  db: () => Database;
}

export interface Person {
  id: string;
  email: string;
  name: string;
}

/** A response, read: status, the text, and the JSON when it is JSON. */
export interface CallResult {
  status: number;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed bodies are asserted by the tests that read them
  json: any;
  headers: { get(name: string): string | null };
}

export function sharingHelpers({ state, routes, errorHandler, db }: SharingDependencies) {
  const people = new Map<string, Person>();

  async function person(label: string, role = 'user'): Promise<Person> {
    const id = randomUUID();
    const email = `${label.toLowerCase()}-${id.slice(0, 6)}@example.com`;
    const name = `${label} Person`;
    await db().execute(
      sql`insert into "user" (id, name, email, email_verified, role, organization_id)
          values (${id}, ${name}, ${email}, true, ${role}, ${state.organizationId})`,
    );
    const created = { id, email, name };
    people.set(id, created);
    return created;
  }

  function appFor(who: Person, role = state.role) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: who.id,
        email: who.email,
        name: who.name,
        image: null,
        role: role as 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/projects', routes.projectRoutes);
    app.route('/api/threads', routes.threadRoutes);
    app.route('/api/attachments', routes.attachmentRoutes);
    return app;
  }

  async function call(
    who: Person,
    method: string,
    path: string,
    body?: unknown,
    role?: string,
  ): Promise<CallResult> {
    const response = await appFor(who, role).request(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: CallResult['json'];
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json, headers: response.headers };
  }

  /** A request that must succeed. */
  async function ok(who: Person, method: string, path: string, body?: unknown, status = 200) {
    const response = await call(who, method, path, body);
    expect(response.status, response.text).toBe(status);
    return response.json;
  }

  async function createProject(owner: Person, name: string, instructions = '') {
    return (await ok(owner, 'POST', '/projects', { name, instructions }, 201)).project as {
      id: string;
      name: string;
    };
  }

  /** The sharing route, as the owner does it. */
  async function shareWith(
    owner: Person,
    projectId: string,
    who: Person,
    permission: 'viewer' | 'editor',
  ) {
    return (
      await ok(
        owner,
        'POST',
        `/projects/${projectId}/shares`,
        { subject: { type: 'person', email: who.email }, permission },
        201,
      )
    ).share as { id: string };
  }

  async function shareWithGroup(
    owner: Person,
    projectId: string,
    groupId: string,
    permission: 'viewer' | 'editor',
  ) {
    return (
      await ok(
        owner,
        'POST',
        `/projects/${projectId}/shares`,
        { subject: { type: 'group', groupId }, permission },
        201,
      )
    ).share as { id: string };
  }

  async function makeGroup(name: string, members: Person[]) {
    const [row] = await db()
      .insert(schema.group)
      .values({ organizationId: state.organizationId, name: `${name} ${randomUUID().slice(0, 6)}` })
      .returning();
    for (const member of members) {
      await db().insert(schema.groupMember).values({ groupId: row!.id, userId: member.id });
    }
    return row!.id;
  }

  /** A finished project file, straight into the tables, indexed for search. */
  async function seedFile(
    uploader: Person,
    projectId: string,
    filename: string,
    text: string,
    options: { pending?: boolean } = {},
  ) {
    const [row] = await db()
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: uploader.id,
        projectId,
        filename,
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        storageKey: randomUUID(),
        extractedText: text,
        uploadPending: options.pending ?? false,
      })
      .returning();
    // As the upload does, in one step: the counters count the row.
    await db().execute(sql`
      insert into storage_usage (organization_id, user_id, live_bytes, live_file_count)
      values (${state.organizationId}, ${uploader.id}, ${row!.sizeBytes}, 1)
      on conflict (user_id) do update set
        live_bytes = storage_usage.live_bytes + ${row!.sizeBytes},
        live_file_count = storage_usage.live_file_count + 1`);
    return row!;
  }

  async function upload(
    who: Person,
    projectId: string,
    name: string,
    body: string,
  ): Promise<Omit<CallResult, 'headers'>> {
    const form = new FormData();
    form.append('files', new File([body], name, { type: 'text/plain' }));
    const response = await appFor(who).request(`/api/projects/${projectId}/files`, {
      method: 'POST',
      body: form,
    });
    const text = await response.text();
    return { status: response.status, text, json: safeJson(text) };
  }

  function safeJson(text: string): CallResult['json'] {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function thread(who: Person, projectId: string | null, title = 'A conversation') {
    const [row] = await db()
      .insert(schema.thread)
      .values({ userId: who.id, organizationId: state.organizationId, projectId, title })
      .returning();
    return row!;
  }

  /** The counter a person's storage meter reads, and the totals of their rows: they must agree. */
  async function storage(who: Person) {
    const [counter] = await db()
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, who.id));
    const [rows] = await db().execute<{ bytes: string; files: number }>(sql`
      select coalesce(sum(size_bytes) filter (where deleted_at is null), 0)::text as bytes,
             (count(*) filter (where deleted_at is null))::int as files
      from attachment where user_id = ${who.id}`);
    return {
      counterBytes: Number(counter?.liveBytes ?? 0),
      counterFiles: Number(counter?.liveFileCount ?? 0),
      rowBytes: Number(rows?.bytes ?? 0),
      rowFiles: Number(rows?.files ?? 0),
    };
  }

  async function filesOf(projectId: string) {
    return db()
      .select({
        id: schema.attachment.id,
        userId: schema.attachment.userId,
        filename: schema.attachment.filename,
        pending: schema.attachment.uploadPending,
      })
      .from(schema.attachment)
      .where(eq(schema.attachment.projectId, projectId))
      .orderBy(schema.attachment.filename);
  }

  async function threadProject(threadId: string) {
    const [row] = await db()
      .select({ projectId: schema.thread.projectId })
      .from(schema.thread)
      .where(eq(schema.thread.id, threadId));
    return row?.projectId ?? null;
  }

  async function hold(who: Person) {
    await db().insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: who.id,
      userEmail: who.email,
      reason: 'Matter 2026-41',
    });
  }

  async function lift(who: Person) {
    await db().execute(sql`update legal_hold set lifted_at = now() where user_id = ${who.id}`);
  }

  async function auditOf(action: string, targetId?: string) {
    const rows = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
    return targetId ? rows.filter((row) => row.targetId === targetId) : rows;
  }

  return {
    person,
    appFor,
    call,
    ok,
    createProject,
    shareWith,
    shareWithGroup,
    makeGroup,
    seedFile,
    upload,
    thread,
    storage,
    filesOf,
    threadProject,
    hold,
    lift,
    auditOf,
  };
}
