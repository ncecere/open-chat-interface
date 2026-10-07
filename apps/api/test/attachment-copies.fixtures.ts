import { type createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';
import type { StorageDriver } from '../src/services/storage/driver.js';

/**
 * Shared by the attachment-copy live suites (#358): conversations with files,
 * forks and edits made through the real routes, and every way of deleting
 * them, against real PostgreSQL (with its storage triggers) and a real
 * object store. The suites declare their own mocks and databases; this holds
 * what they have in common.
 */

/** The values a suite's hoisted mocks read. */
export interface CopiesState {
  db: unknown;
  sql: unknown;
  organizationId: string;
  driver: StorageDriver | null;
  settings: Map<string, unknown>;
}

export const DAY = 86_400_000;

export function defaultSettings(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['features', { attachments: true, temporaryChat: true, branching: true }],
    [
      'storage',
      {
        driver: 'local',
        maxFileBytes: 20 * 1024 * 1024,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain'],
      },
    ],
    ['roleFeatures', {}],
    [
      'retention',
      {
        threadRetentionDays: 30,
        trashRetentionDays: 7,
        auditLogRetentionDays: 30,
        usageEventRetentionDays: 30,
        memoryRetentionDays: 30,
        exemptPinnedThreads: false,
      },
    ],
  ]);
}

export function copiesHarness(ctx: {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly state: CopiesState;
}) {
  const db = () => ctx.pool.db;
  const touched = new Set<string>();

  async function appFor(userId: string) {
    const { threadRoutes } = await import('../src/routes/threads.js');
    const { attachmentRoutes } = await import('../src/routes/attachments.js');
    const { errorHandler } = await import('../src/middleware/error-handler.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: ctx.state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    app.route('/api/attachments', attachmentRoutes);
    return app;
  }

  async function call(userId: string, method: string, path: string, body?: unknown) {
    const response = await (await appFor(userId)).request(path, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    return response;
  }

  /** Uploads a text file through the real route and returns its row. */
  async function upload(userId: string, filename: string, text: string) {
    const form = new FormData();
    form.append('files', new File([text], filename, { type: 'text/plain' }));
    const response = await (await appFor(userId)).request('/api/attachments', {
      method: 'POST',
      body: form,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { attachments } = (await response.json()) as { attachments: Array<{ id: string }> };
    const [row] = await db()
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, attachments[0]!.id));
    touched.add(row!.storageKey);
    return row!;
  }

  /**
   * A conversation as chat leaves it: a question sent with one file and a
   * reply, with the file's part as the chat route writes it.
   */
  async function conversation(
    userId: string,
    options: { filename?: string; text?: string; projectId?: string } = {},
  ) {
    const file = await upload(
      userId,
      options.filename ?? 'grant.txt',
      options.text ?? 'The drainage trench costs $650 and the project starts in March 2027.',
    );
    const [chat] = await db()
      .insert(schema.thread)
      .values({
        userId,
        organizationId: ctx.state.organizationId,
        title: 'Grant questions',
        projectId: options.projectId ?? null,
        lastMessageAt: new Date(),
      })
      .returning();
    const [question] = await db()
      .insert(schema.message)
      .values({
        threadId: chat!.id,
        userId,
        role: 'user',
        position: 0,
        parts: [
          { type: 'text', text: 'What does the file say about the trench?' },
          {
            type: 'data-attachment',
            data: {
              id: file.id,
              filename: file.filename,
              mimeType: file.mimeType,
              url: `/api/attachments/${file.id}/content`,
            },
          },
        ],
      })
      .returning();
    await db()
      .update(schema.attachment)
      .set({ messageId: question!.id })
      .where(eq(schema.attachment.id, file.id));
    const [reply] = await db()
      .insert(schema.message)
      .values({
        threadId: chat!.id,
        userId,
        role: 'assistant',
        position: 1,
        parentMessageId: question!.id,
        parts: [{ type: 'text', text: 'The trench costs $650.' }],
      })
      .returning();
    return { thread: chat!, question: question!, reply: reply!, file };
  }

  /** A fork through the real route, made at `messageId`. */
  async function fork(userId: string, threadId: string, messageId: string) {
    const response = await call(userId, 'POST', `/api/threads/${threadId}/forks`, { messageId });
    expect(response.status).toBe(201);
    return ((await response.json()) as { thread: { id: string } }).thread.id;
  }

  /** An edit that keeps the question's files, through the real route. */
  async function edit(userId: string, threadId: string, messageId: string, text = 'Edited?') {
    const response = await call(userId, 'POST', `/api/threads/${threadId}/branches`, {
      messageId,
      text,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { thread: { id: string } }).thread.id;
  }

  /** The attachment rows of a conversation's messages. */
  async function filesOf(threadId: string) {
    return db()
      .select({ file: schema.attachment })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .where(eq(schema.message.threadId, threadId))
      .then((rows) => rows.map((row) => row.file));
  }

  /** What the content route answers for a file: its status and, if served, its bytes. */
  async function served(userId: string, attachmentId: string) {
    const response = await call(userId, 'GET', `/api/attachments/${attachmentId}/content`);
    return {
      status: response.status,
      text: response.status === 200 ? await response.text() : null,
    };
  }

  /** The reaper, as its job runs it (everything queued is due). */
  async function drain() {
    const { drainDeletedObjects } = await import('../src/services/storage/reaper.js');
    let total = 0;
    // A parked entry is made due by one pass and deleted by the next.
    for (let pass = 0; pass < 3; pass++)
      total += await drainDeletedObjects(new Date(Date.now() + 5));
    return total;
  }

  const objectExists = (key: string) => ctx.state.driver!.exists(key);

  async function usage(userId: string) {
    const [row] = await db().execute<{
      live_bytes: string;
      live_file_count: number;
      pending_bytes: string;
      pending_file_count: number;
    }>(sql`select * from storage_usage where user_id = ${userId}`);
    return {
      liveBytes: Number(row?.live_bytes ?? 0),
      liveFiles: row?.live_file_count ?? 0,
      pendingBytes: Number(row?.pending_bytes ?? 0),
      pendingFiles: row?.pending_file_count ?? 0,
    };
  }

  async function cleanup() {
    await Promise.all([...touched].map((key) => ctx.state.driver?.delete(key).catch(() => {})));
  }

  /** Ages a thread's deletion so the trash purge treats it as expired. */
  async function expireInTrash(threadId: string) {
    const when = new Date(Date.now() - 30 * DAY).toISOString();
    await db().execute(
      sql`update thread set deleted_at = ${when}::timestamptz where id = ${threadId}`,
    );
    await db().execute(sql`
      update attachment set deleted_at = ${when}::timestamptz
      where deleted_reason = 'thread' and message_id in (select id from message where thread_id = ${threadId})
    `);
  }

  return {
    call,
    upload,
    conversation,
    fork,
    edit,
    filesOf,
    served,
    drain,
    objectExists,
    usage,
    cleanup,
    expireInTrash,
    touched,
  };
}
