import { schema } from '@oci/db';
import type { db } from '../../db/index.js';
import { copyArtifactsToFork } from '../artifacts/store.js';
import { insertPlannedFiles, planFileCopies } from '../attachments/copies.js';
import { copyCompactionToFork } from './compaction-fork.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Copies messages into a fork or edit as new rows that keep their source ids
 * as lineage, with the compaction summary, artifacts and files made along
 * them. A file gets a row of its own for the copy (#358), so deleting the
 * source conversation never takes the fork's files with it.
 */
export async function copyMessagesInto(
  tx: Transaction,
  input: {
    sourceThreadId: string;
    threadId: string;
    userId: string;
    messages: (typeof schema.message.$inferSelect)[];
  },
) {
  if (input.messages.length === 0) return;
  const plans = await planFileCopies(
    tx,
    input.userId,
    input.messages.map((message) => message.parts),
  );
  const copies = await tx
    .insert(schema.message)
    .values(
      input.messages.map((message, index) => ({
        threadId: input.threadId,
        userId: input.userId,
        role: message.role,
        parts: plans[index]!.parts,
        position: message.position,
        parentMessageId: message.id,
        modelSlug: message.modelSlug,
        effort: message.effort,
        webSearchUsed: message.webSearchUsed,
        status: message.status,
        errorMessage: message.errorMessage,
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        durationMs: message.durationMs,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
    )
    .returning({ id: schema.message.id, sourceId: schema.message.parentMessageId });
  const planBySource = new Map(input.messages.map((message, index) => [message.id, plans[index]!]));
  await insertPlannedFiles(
    tx,
    input.userId,
    copies.map((copy) => ({ messageId: copy.id, files: planBySource.get(copy.sourceId!)!.files })),
  );
  const target = {
    sourceThreadId: input.sourceThreadId,
    threadId: input.threadId,
    userId: input.userId,
    copied: new Map(copies.map((copy) => [copy.sourceId!, copy.id])),
  };
  await copyCompactionToFork(tx, target);
  await copyArtifactsToFork(tx, target);
}
