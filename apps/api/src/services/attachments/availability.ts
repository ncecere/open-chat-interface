import { and, eq, inArray, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { attachmentIds, historicalAttachmentAvailable } from '../chat/attachment-context.js';

/**
 * Which files a conversation shows can no longer be opened (#359): removed by
 * their owner or an administrator, expired with their conversation, or gone
 * from the database. The page marks them in the message parts it returns, as
 * "No longer available", where before they looked like any other file and
 * their link answered 404. The test is the one the model's context uses
 * (`historicalAttachmentAvailable`), so what the person is shown and what the
 * model is told never disagree.
 */

type Row = { id: string; role: string; parts: unknown };

/** The ids of the files the given messages show that are not available to `userId`. */
export async function unavailableFileIds(userId: string, messages: Row[]): Promise<Set<string>> {
  const wanted = [...new Set(messages.flatMap((message) => attachmentIds(message)))];
  const found = new Set<string>();
  // Bounded lists keep a very long conversation from building a huge query.
  for (let index = 0; index < wanted.length; index += 1_000) {
    const rows = await db
      .select({ id: schema.attachment.id })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .innerJoin(schema.thread, eq(schema.thread.id, schema.message.threadId))
      .where(
        and(
          inArray(schema.attachment.id, wanted.slice(index, index + 1_000)),
          historicalAttachmentAvailable(userId),
        ),
      );
    for (const row of rows) found.add(row.id);
  }
  return new Set(wanted.filter((id) => !found.has(id)));
}

/**
 * The message's parts with `available: false` on each file in `gone` and on
 * each part the server stored as removed by its owner (`removed: true`, #378).
 */
export function markUnavailableFiles<T extends { parts: unknown }>(
  message: T,
  gone: ReadonlySet<string>,
): T {
  if (!Array.isArray(message.parts)) return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part?.type !== 'data-attachment' || typeof part.data?.id !== 'string') return part;
    if (!gone.has(part.data.id) && part.data.removed !== true) return part;
    if (part.data.available === false) return part;
    changed = true;
    return { ...part, data: { ...part.data, available: false } };
  });
  return changed ? { ...message, parts } : message;
}
