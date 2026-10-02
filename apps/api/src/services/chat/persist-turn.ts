import { and, asc, eq, gt, inArray, ne, schema, sql } from '@oci/db';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { conflict, validationFailed } from '../../lib/errors.js';
import { deriveTitle } from '../threads.js';
import {
  type HistoricalAttachmentReference,
  historicalAttachmentAvailable,
  type ModelAttachment,
} from './attachment-context.js';
import { textFromParts } from './message-parts.js';
import { activeMessage, RETRY_LATEST_ONLY } from './reply-path.js';
import type { AcquiredRun } from './run-lifecycle.js';
import { lockChatThread } from './thread-claim.js';
import type { TurnContext } from './turn-context.js';

/** Commit prompt, attachment allocation, title and assistant lineage together. */
export async function persistTurn(
  { user, input, thread, resolved }: TurnContext,
  run: AcquiredRun,
  latest: UIMessage,
  attachments: ModelAttachment[],
  regenerationParent: string,
  historicalAttachments: HistoricalAttachmentReference[] = [],
) {
  const result = await db.transaction(async (tx) => {
    const currentThread = await lockChatThread(tx, thread.id, user.id);
    const [claim] = await tx
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, run.assistantMessage.id),
          eq(schema.message.threadId, thread.id),
          eq(schema.message.userId, user.id),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
        ),
      );
    if (!claim || claim.parentMessageId !== null)
      throw conflict('Chat admission is no longer valid');
    const [last] = await tx
      .select({ position: sql<number>`coalesce(max(${schema.message.position}), -1)::int` })
      .from(schema.message)
      .where(and(eq(schema.message.threadId, thread.id), ne(schema.message.id, claim.id)));
    let position = (last?.position ?? -1) + 1;
    let promptMessageId = regenerationParent;
    let submittedMessageId: string | null = null;
    const ids = [...new Set(input.attachmentIds)];
    const historical = new Map(historicalAttachments.map((file) => [file.id, file.messageId]));
    const allIds = [...new Set([...ids, ...historical.keys()])];
    if (allIds.length) {
      // Read-only historical uses may share a file, but allocation needs an
      // exclusive lock. Never wait on either: hard-purge cascades may visit
      // files in another order, and waiting after taking a file lock can cycle.
      // A conflicting writer means this snapshot is busy/unavailable; retry.
      const lockFiles = async (fileIds: string[], strength: 'update' | 'share') =>
        tx
          .select({
            id: schema.attachment.id,
            messageId: schema.attachment.messageId,
            deletedAt: schema.attachment.deletedAt,
            uploadPending: schema.attachment.uploadPending,
          })
          .from(schema.attachment)
          .where(and(eq(schema.attachment.userId, user.id), inArray(schema.attachment.id, fileIds)))
          .orderBy(asc(schema.attachment.id))
          .for(strength, { skipLocked: true });
      const historicalIds = [...historical.keys()].filter((id) => !ids.includes(id));
      const files = [
        ...(ids.length ? await lockFiles(ids, 'update') : []),
        ...(historicalIds.length ? await lockFiles(historicalIds, 'share') : []),
      ];
      if (
        files.length !== allIds.length ||
        files.some(
          (file) =>
            file.deletedAt !== null ||
            file.uploadPending ||
            (ids.includes(file.id)
              ? file.messageId !== null
              : file.messageId !== historical.get(file.id)),
        )
      ) {
        throw validationFailed(
          'Attachments must be owned, available, not busy and not already sent',
        );
      }
      if (historical.size) {
        const available = await tx
          .select({ id: schema.attachment.id })
          .from(schema.attachment)
          .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
          .innerJoin(schema.thread, eq(schema.thread.id, schema.message.threadId))
          .where(
            and(
              inArray(schema.attachment.id, [...historical.keys()]),
              historicalAttachmentAvailable(user.id),
            ),
          );
        if (available.length !== historical.size)
          throw validationFailed('Historical attachments are no longer available');
      }
    }
    if (input.trigger === 'submit-message') {
      const [stored] = await tx
        .insert(schema.message)
        .values({
          threadId: thread.id,
          userId: user.id,
          role: 'user',
          parts: [
            ...latest.parts,
            ...attachments.map((file) => ({
              type: 'data-attachment',
              data: {
                id: file.id,
                filename: file.filename,
                mimeType: file.mimeType,
                url: `/api/attachments/${file.id}/content`,
              },
            })),
          ] as unknown as Record<string, unknown>[],
          position,
          modelSlug: resolved.slug,
          effort: input.effort ?? null,
          status: 'complete',
        })
        .returning({ id: schema.message.id });
      if (!stored) throw new Error('Failed to persist user message');
      promptMessageId = stored.id;
      submittedMessageId = stored.id;
      if (ids.length) {
        const linked = await tx
          .update(schema.attachment)
          .set({ messageId: stored.id })
          .where(inArray(schema.attachment.id, ids))
          .returning({ id: schema.attachment.id });
        if (linked.length !== ids.length) throw validationFailed('Attachment allocation failed');
      }
      if (position === 0 && currentThread.title === 'New Chat') {
        await tx
          .update(schema.thread)
          .set({ title: deriveTitle(textFromParts(latest.parts)) })
          .where(eq(schema.thread.id, thread.id));
      }
      position++;
    } else {
      // A retry: the new reply becomes the turn's active one. Recheck under the
      // thread lock that the target is still the latest user turn.
      const [target] = await tx
        .select({ position: schema.message.position })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.id, promptMessageId),
            eq(schema.message.threadId, thread.id),
            eq(schema.message.role, 'user'),
          ),
        );
      if (!target)
        throw validationFailed('The regeneration target must be a user message in this thread');
      const [later] = await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.threadId, thread.id),
            eq(schema.message.role, 'user'),
            gt(schema.message.position, target.position),
          ),
        )
        .limit(1);
      if (later) throw validationFailed(RETRY_LATEST_ONLY);
      await tx
        .update(schema.message)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(schema.message.threadId, thread.id),
            eq(schema.message.role, 'assistant'),
            ne(schema.message.id, claim.id),
            gt(schema.message.position, target.position),
            activeMessage(),
          ),
        );
    }
    await tx
      .update(schema.message)
      .set({ parentMessageId: promptMessageId, position })
      .where(eq(schema.message.id, claim.id));
    return { promptMessageId, submittedMessageId };
  });
  run.turnPersisted = true;
  return result;
}
