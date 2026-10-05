import { randomUUID } from 'node:crypto';
import { type createDatabase, eq, schema } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import { expect, type MockInstance } from 'vitest';
import type * as attachmentContext from '../src/services/chat/attachment-context.js';
import type { AcquiredRun } from '../src/services/chat/run-lifecycle.js';
import type { setupTurn } from '../src/services/chat/setup-turn.js';
import type { LocalStorageDriver } from '../src/services/storage/local-driver.js';

/**
 * Shared by the chat-context-budget*.live.test.ts suites: turn preparation
 * (setupTurn) against real PostgreSQL and local blob storage, stopping before
 * any provider call. Each suite declares its own mocks and creates its own
 * database.
 */

export type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
export type FileRow = typeof schema.attachment.$inferSelect;
export type HistoryRow = {
  role: 'user' | 'assistant';
  text: string;
  files?: FileRow[];
  padding?: string;
};

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
);
export const MiB = 1024 * 1024;

export async function sdkMessages(started: StartedTurn) {
  return convertToModelMessages(started.turn.uiMessages);
}
export async function sdkText(started: StartedTurn) {
  return (await sdkMessages(started))
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
}

/** What the helpers need from a suite; read when a helper runs, after the hooks. */
export interface BudgetSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly owner: string;
  readonly organizationId: string;
  readonly driver: LocalStorageDriver;
  readonly runs: Set<AcquiredRun>;
  readonly getBlob: MockInstance<LocalStorageDriver['get']>;
  readonly materialize: MockInstance<typeof attachmentContext.materializeAttachments>;
  /** The suite's hoisted mock state: admission handles released so far. */
  readonly state: {
    released: number;
    quotaReleased: number;
    abandoned: number;
    unregistered: number;
  };
}

export function budgetHelpers(suite: BudgetSuite) {
  async function thread() {
    const [row] = await suite.pool.db
      .insert(schema.thread)
      .values({ userId: suite.owner, organizationId: suite.organizationId })
      .returning();
    return row!;
  }
  async function messages(threadId: string) {
    return suite.pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function attachment(
    options: { image?: boolean; text?: string; sizeBytes?: number; missingBlob?: boolean } = {},
  ) {
    const bytes = options.image ? png : Buffer.from('uploaded document fixture');
    const mimeType = options.image ? 'image/png' : 'text/plain';
    const [row] = await suite.pool.db
      .insert(schema.attachment)
      .values({
        organizationId: suite.organizationId,
        userId: suite.owner,
        filename: options.image ? 'pixel.png' : 'document.txt',
        mimeType,
        sizeBytes: options.sizeBytes ?? bytes.length,
        storageKey: randomUUID(),
        extractedText: options.image ? null : (options.text ?? 'DOCUMENT_CONTENT'),
      })
      .returning();
    if (!options.missingBlob) await suite.driver.put(row!.storageKey, bytes, mimeType);
    return row!;
  }
  async function seedHistory(threadId: string, rows: HistoryRow[]) {
    const values = rows.map((row, position) => ({
      id: randomUUID(),
      userId: suite.owner,
      threadId,
      role: row.role,
      position,
      status: 'complete' as const,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, position)),
      parts: [
        { type: 'text', text: row.text },
        ...(row.files ?? []).map((file) => ({
          type: 'data-attachment',
          data: {
            id: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            url: `/api/attachments/${file.id}/content`,
          },
        })),
        ...(row.padding ? [{ type: 'data-fixture', data: { padding: row.padding } }] : []),
      ],
    }));
    await suite.pool.db.insert(schema.message).values(values);
    for (const [index, row] of rows.entries()) {
      for (const file of row.files ?? []) {
        await suite.pool.db
          .update(schema.attachment)
          .set({ messageId: values[index]!.id })
          .where(eq(schema.attachment.id, file.id));
      }
    }
    return values;
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../src/services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: suite.owner, name: 'Budget Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'budget-test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
        ...extra,
      },
    );
    suite.runs.add(started.run);
    return started;
  }
  async function expectRejected(
    threadId: string,
    text: string,
    files: FileRow[] = [],
    extra: Partial<SendMessageInput> = {},
    expected: { materialized?: boolean; blobReads?: number; message?: string } = {},
  ) {
    const { state } = suite;
    const before = await messages(threadId);
    const counts = {
      released: state.released,
      quotaReleased: state.quotaReleased,
      abandoned: state.abandoned,
      unregistered: state.unregistered,
    };
    const request = send(threadId, text, { attachmentIds: files.map((file) => file.id), ...extra });
    await expect(request).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    if (expected.message) await expect(request).rejects.toThrow(expected.message);
    // No prompt, failed assistant or provisional claim survives rejected preparation.
    expect(await messages(threadId)).toEqual(before);
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      expect(state[key], key).toBe(counts[key] + 1);
    }
    for (const file of files) {
      const [stored] = await suite.pool.db
        .select({ messageId: schema.attachment.messageId, deletedAt: schema.attachment.deletedAt })
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(stored).toEqual({ messageId: null, deletedAt: null });
    }
    if (expected.materialized) expect(suite.materialize).toHaveBeenCalledOnce();
    else expect(suite.materialize).not.toHaveBeenCalled();
    expect(suite.getBlob).toHaveBeenCalledTimes(expected.blobReads ?? 0);
  }

  return { thread, messages, attachment, seedHistory, send, expectRejected };
}
