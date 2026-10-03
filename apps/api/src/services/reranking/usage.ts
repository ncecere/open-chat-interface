import { and, eq, schema, sql } from '@oci/db';
import { SEARCHES_PER_RERANK_PRICE } from '@oci/shared';
import { db } from '../../db/index.js';
import { lockUsageOwner, settleLockedEvent } from '../quota/settlement.js';
import { rerankUsageSlug } from './config.js';

/** What one reranked message costs at a price per 1,000 searches, rounded up. */
export function rerankCostMicros(searchPriceMicros: number | null): number {
  if (!searchPriceMicros || searchPriceMicros <= 0) return 0;
  return Math.ceil(searchPriceMicros / SEARCHES_PER_RERANK_PRICE);
}

/**
 * Records one reranked message as a usage event of the person asking, and in
 * the daily rollup, in one transaction, through the same settlement as a reply
 * and as embeddings. Unlike an embeddings call it is recorded even when the
 * provider reports no tokens (most rerankers do not): it is priced per search,
 * so the event itself is what is charged. It counts no message. Nothing is
 * recorded when the person no longer exists.
 */
export async function recordRerankUsage(params: {
  organizationId: string;
  userId: string;
  modelId: string;
  tokens: number;
  searchPriceMicros: number | null;
}): Promise<void> {
  const tokens = Number.isInteger(params.tokens) && params.tokens > 0 ? params.tokens : 0;
  const costMicros = rerankCostMicros(params.searchPriceMicros);
  const modelSlug = rerankUsageSlug(params.modelId);
  await db.transaction(async (tx) => {
    if (!(await lockUsageOwner(tx, params.userId))) return;
    const [event] = await tx
      .insert(schema.usageEvent)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        modelSlug,
        messageCount: 0,
        inputPriceMicros: null,
        outputPriceMicros: null,
        pending: true,
      })
      .returning();
    // Settles tokens at no token price, then adds the per-search price to
    // both the event and its rollup row, which the settlement just wrote.
    await settleLockedEvent(tx, event!, { tokensIn: tokens, tokensOut: 0 });
    if (costMicros === 0) return;
    await tx
      .update(schema.usageEvent)
      .set({ costMicros })
      .where(eq(schema.usageEvent.id, event!.id));
    await tx
      .update(schema.usageRecord)
      .set({
        costMicros: sql`${schema.usageRecord.costMicros} + ${costMicros}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.usageRecord.userId, params.userId),
          eq(schema.usageRecord.modelSlug, modelSlug),
          eq(schema.usageRecord.day, event!.occurredAt.toISOString().slice(0, 10)),
        ),
      );
  });
}
