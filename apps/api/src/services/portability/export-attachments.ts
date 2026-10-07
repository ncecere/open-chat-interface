import { and, asc, eq, inArray, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { attachmentIds } from '../chat/attachment-context.js';

export type AttachmentRow = Pick<
  typeof schema.attachment.$inferSelect,
  'id' | 'messageId' | 'filename' | 'mimeType' | 'sizeBytes' | 'storageKey' | 'createdAt'
>;

const columns = {
  id: schema.attachment.id,
  messageId: schema.attachment.messageId,
  filename: schema.attachment.filename,
  mimeType: schema.attachment.mimeType,
  sizeBytes: schema.attachment.sizeBytes,
  storageKey: schema.attachment.storageKey,
  createdAt: schema.attachment.createdAt,
};

/**
 * Ready, live files this person owns that the given messages show, in the
 * order they were uploaded: those their messages own, and those their parts
 * name that belong to another message (#364).
 *
 * The second kind is what a fork or an edit made before 0.11 shows: it carried
 * the original's attachment id and had no row of its own, so its export listed
 * no files although its messages and its Markdown ("_Attached: ..._") showed
 * them. Now each has its own row and the first query finds it; the second
 * keeps an instance that has not yet converted its old forks (the background
 * migration `0.11.attachment-own-rows`) exporting every file a conversation
 * shows. Such a file is listed against the message of this conversation that
 * shows it, so every file's `messageId` is one of the exported messages.
 */
export async function attachmentsForMessages(
  userId: string,
  messages: Array<{ id: string; role: string; parts: unknown }>,
): Promise<AttachmentRow[]> {
  if (messages.length === 0) return [];
  const messageIds = messages.map((message) => message.id);
  const live = and(
    eq(schema.attachment.userId, userId),
    isNull(schema.attachment.deletedAt),
    eq(schema.attachment.uploadPending, false),
  );
  const rows: AttachmentRow[] = [];
  // Bounded IN-lists keep a very long conversation from building a huge query.
  for (let index = 0; index < messageIds.length; index += 1_000) {
    rows.push(
      ...(await db
        .select(columns)
        .from(schema.attachment)
        .where(
          and(live, inArray(schema.attachment.messageId, messageIds.slice(index, index + 1_000))),
        )
        .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))),
    );
  }
  const owned = new Set(rows.map((row) => row.id));
  const shownIn = new Map<string, string>();
  for (const message of messages)
    for (const id of attachmentIds(message))
      if (!owned.has(id) && !shownIn.has(id)) shownIn.set(id, message.id);
  const shared = [...shownIn.keys()];
  for (let index = 0; index < shared.length; index += 1_000) {
    const found = await db
      .select(columns)
      .from(schema.attachment)
      .where(
        and(
          live,
          isNull(schema.attachment.projectId),
          inArray(schema.attachment.id, shared.slice(index, index + 1_000)),
        ),
      )
      .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
    rows.push(...found.map((row) => ({ ...row, messageId: shownIn.get(row.id) ?? row.messageId })));
  }
  // Chunks and the two kinds are each in order; one list is too (ids are
  // fixed-width hexadecimal UUIDs, so their order is the same in any collation).
  return rows.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
}
