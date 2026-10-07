import { randomUUID } from 'node:crypto';
import { type createDatabase, eq, schema } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import { expect } from 'vitest';
import type { AcquiredRun } from '../src/services/chat/run-lifecycle.js';
import type { setupTurn } from '../src/services/chat/setup-turn.js';
import type { LocalStorageDriver } from '../src/services/storage/local-driver.js';

/**
 * Shared by the chat-attachment-context*.live.test.ts suites: turn preparation
 * (setupTurn) with historical attachments against real PostgreSQL and local
 * blob storage, stopping before any provider call. Each suite declares its
 * own mocks and creates its own database.
 */

export type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
);
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// Inspect the actual SDK model messages, not merely UI metadata that the SDK drops.
export async function modelParts(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages.flatMap((message) =>
    message.role === 'user' && Array.isArray(message.content) ? message.content : [],
  );
}
export async function modelText(started: StartedTurn) {
  return (await modelParts(started))
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}
export async function imageBytes(started: StartedTurn) {
  const binaries = (await modelParts(started)).filter(
    (part) => part.type === 'image' || part.type === 'file',
  );
  expect(binaries).toHaveLength(1);
  const part = binaries[0]!;
  expect(part.mediaType).toBe('image/png');
  const raw = part.type === 'image' ? part.image : part.data;
  // This SDK represents files with a discriminated data envelope, including
  // data URLs; inspect that URL rather than base64-decoding '[object Object]'.
  const data =
    typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'url' ? raw.url : raw;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  expect(typeof data === 'string' || data instanceof URL).toBe(true);
  const encoded = String(data);
  expect(encoded).not.toMatch(/^https?:/);
  return Buffer.from(encoded.replace(/^data:[^,]*,/, ''), 'base64');
}

/** What the helpers need from a suite; read when a helper runs, after the hooks. */
export interface AttachmentSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly owner: string;
  readonly organizationId: string;
  readonly driver: LocalStorageDriver;
  readonly runs: Set<AcquiredRun>;
  /** The suite's hoisted mock state: stream slots released so far. */
  readonly state: { released: number };
}

export function attachmentHelpers(suite: AttachmentSuite) {
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
    mimeType = 'text/plain',
    extractedText: string | null = 'fixture text',
  ) {
    // Seed extraction results directly: this suite tests context, not PDF extraction/upload.
    const bytes = mimeType === 'image/png' ? png : Buffer.from(extractedText ?? 'fixture');
    const [row] = await suite.pool.db
      .insert(schema.attachment)
      .values({
        organizationId: suite.organizationId,
        userId: suite.owner,
        filename:
          mimeType === 'image/png'
            ? 'pixel.png'
            : mimeType === 'application/pdf'
              ? 'report.pdf'
              : 'note.txt',
        mimeType,
        sizeBytes: bytes.length,
        storageKey: randomUUID(),
        extractedText,
      })
      .returning();
    await suite.driver.put(row!.storageKey, bytes, mimeType);
    return row!;
  }
  async function send(
    threadId: string,
    text: string,
    extra: Partial<SendMessageInput> = {},
    role: 'user' | 'restricted' = 'user',
  ) {
    const { setupTurn } = await import('../src/services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: suite.owner, name: 'Test User', role },
      {
        threadId,
        modelSlug: 'test-model',
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
  async function complete(started: StartedTurn) {
    await suite.pool.db
      .update(schema.message)
      .set({ status: 'complete', parts: [{ type: 'text', text: 'Fixture reply' }] })
      .where(eq(schema.message.id, started.run.assistantMessage.id));
    const { releaseRunHandles } = await import('../src/services/chat/run-cleanup.js');
    await releaseRunHandles(started.run, true);
    suite.runs.delete(started.run);
  }
  async function assertFailedWithoutWrites(
    threadId: string,
    before: Awaited<ReturnType<typeof messages>>,
    released: number,
  ) {
    expect(await messages(threadId)).toEqual(before);
    expect(suite.state.released).toBe(released + 1);
  }

  return { thread, messages, attachment, send, complete, assertFailedWithoutWrites };
}
