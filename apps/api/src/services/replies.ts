import { and, eq, gt, ne, schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';
import { activeMessage, RETRY_LATEST_ONLY } from './chat/reply-path.js';
import { lockChatThread } from './chat/thread-claim.js';

/**
 * Makes `messageId` the active reply of the thread's latest turn. Owner only
 * (anyone else gets 404), refused while any reply in the thread is still
 * generating, and idempotent for the reply that is already active.
 */
export async function activateReply(threadId: string, userId: string, messageId: string) {
  return db.transaction(async (tx) => {
    // The thread row lock serialises this with chat admission (claimThread),
    // so a reply cannot start generating between the check and the switch.
    await lockChatThread(tx, threadId, userId);
    const [streaming] = await tx
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.threadId, threadId),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
        ),
      )
      .limit(1);
    if (streaming) throw conflict('Wait for the current reply to finish before switching replies');

    const [target] = await tx
      .select({
        id: schema.message.id,
        role: schema.message.role,
        position: schema.message.position,
      })
      .from(schema.message)
      .where(and(eq(schema.message.id, messageId), eq(schema.message.threadId, threadId)))
      .limit(1);
    if (!target) throw notFound('Message not found');
    if (target.role !== 'assistant') throw validationFailed('Only a reply can be selected');

    const [prompt] = await tx
      .select({ position: sql<number | null>`max(${schema.message.position})::int` })
      .from(schema.message)
      .where(and(eq(schema.message.threadId, threadId), eq(schema.message.role, 'user')));
    const promptPosition = prompt?.position ?? null;
    if (promptPosition === null || target.position <= promptPosition)
      throw validationFailed(RETRY_LATEST_ONLY);

    await tx
      .update(schema.message)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(schema.message.threadId, threadId),
          eq(schema.message.role, 'assistant'),
          gt(schema.message.position, promptPosition),
          ne(schema.message.id, target.id),
          activeMessage(),
        ),
      );
    await tx
      .update(schema.message)
      .set({ supersededAt: null })
      .where(eq(schema.message.id, target.id));
    return { activeMessageId: target.id };
  });
}
