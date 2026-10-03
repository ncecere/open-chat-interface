import { schema } from '@oci/db';
import { db } from '../../db/index.js';
import { lockUsageOwner, settleLockedEvent } from '../quota/settlement.js';
import { embeddingUsageSlug } from './config.js';

/**
 * Records one embeddings call as a usage event and in the daily rollup, in one
 * transaction, through the same settlement as a reply: passages are charged
 * to the file's owner when indexed, a question to the person asking. It counts
 * tokens (and cost, when the administrator set a price) but no message.
 * Nothing is recorded when the provider reported no tokens, or when the
 * person no longer exists.
 */
export async function recordEmbeddingUsage(params: {
  organizationId: string;
  userId: string;
  modelId: string;
  tokens: number;
  inputPriceMicros: number | null;
}): Promise<void> {
  if (!Number.isInteger(params.tokens) || params.tokens <= 0) return;
  await db.transaction(async (tx) => {
    if (!(await lockUsageOwner(tx, params.userId))) return;
    const [event] = await tx
      .insert(schema.usageEvent)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        modelSlug: embeddingUsageSlug(params.modelId),
        messageCount: 0,
        inputPriceMicros: params.inputPriceMicros,
        outputPriceMicros: null,
        pending: true,
      })
      .returning();
    await settleLockedEvent(tx, event!, { tokensIn: params.tokens, tokensOut: 0 });
  });
}
