import { and, desc, eq, gte, schema, sql } from '@oci/db';
import type { ConversationCompaction, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { listAvailableModels } from '../models.js';
import { getSetting } from '../settings.js';
import { activeMessage } from './reply-path.js';

type CompactionRow = typeof schema.conversationCompaction.$inferSelect;
/** The compaction in use, with the position its kept messages start at. */
export type ActiveCompaction = CompactionRow & { firstKeptPosition: number };

/** Automatic compaction is on unless an administrator turned it off. */
export async function autoCompactEnabled(): Promise<boolean> {
  const chat = await getSetting('chat');
  return chat.autoCompact !== false;
}

export function serializeCompaction(row: CompactionRow): ConversationCompaction {
  return {
    id: row.id,
    threadId: row.threadId,
    firstKeptMessageId: row.firstKeptMessageId,
    summary: row.summary,
    reason: row.reason,
    messagesSummarized: row.messagesSummarized,
    tokensSummarized: row.tokensSummarized,
    modelSlug: row.modelSlug,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The newest compaction of a thread, or null. */
export async function latestCompaction(
  threadId: string,
  userId: string,
): Promise<ActiveCompaction | null> {
  const [row] = await db
    .select({ compaction: schema.conversationCompaction, position: schema.message.position })
    .from(schema.conversationCompaction)
    .innerJoin(
      schema.message,
      eq(schema.message.id, schema.conversationCompaction.firstKeptMessageId),
    )
    .where(
      and(
        eq(schema.conversationCompaction.threadId, threadId),
        eq(schema.conversationCompaction.userId, userId),
        eq(schema.message.threadId, threadId),
      ),
    )
    .orderBy(desc(schema.conversationCompaction.createdAt), desc(schema.conversationCompaction.id))
    .limit(1);
  return row ? { ...row.compaction, firstKeptPosition: row.position } : null;
}

/**
 * The model "Summarise earlier messages now" uses when the request names none:
 * the one that wrote the conversation's latest reply, unless that reply failed
 * (#363). A model that just failed would fail the summary too, and the person
 * has no way to know, so the person's own default model, then the instance
 * default, stands in; the failed one only when nothing else is available.
 * Null when no reply recorded a model.
 */
export async function defaultSummaryModel(
  threadId: string,
  userId: string,
  role: UserRole,
): Promise<string | null> {
  const [latest] = await db
    .select({ modelSlug: schema.message.modelSlug, status: schema.message.status })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, threadId),
        eq(schema.message.role, 'assistant'),
        activeMessage(),
        sql`${schema.message.modelSlug} is not null`,
      ),
    )
    .orderBy(desc(schema.message.position), desc(schema.message.createdAt))
    .limit(1);
  if (!latest?.modelSlug) return null;
  if (latest.status !== 'error') return latest.modelSlug;

  const [preference] = await db
    .select({ modelSlug: schema.userPreference.defaultModelSlug })
    .from(schema.userPreference)
    .where(eq(schema.userPreference.userId, userId))
    .limit(1);
  const catalog = await listAvailableModels(role);
  const usable = (slug: string | null | undefined) =>
    slug && slug !== latest.modelSlug && catalog.some((model) => model.slug === slug) ? slug : null;
  return (
    usable(preference?.modelSlug) ??
    usable(catalog.find((model) => model.isDefault)?.slug) ??
    usable(catalog[0]?.slug) ??
    latest.modelSlug
  );
}

/**
 * Whether "Summarise earlier messages now" has anything to summarise: at
 * least two turns (questions) since the previous summary's cut, so the newest
 * turn can stay whole and an earlier one be summarised. The request refuses
 * with NOTHING_TO_COMPACT otherwise; the state reports it too, so the control
 * can say so before anyone fills in the dialog (#153).
 */
export async function hasTurnsToSummarise(
  threadId: string,
  userId: string,
  previous: { firstKeptPosition: number } | null,
): Promise<boolean> {
  const [turns] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, threadId),
        eq(schema.message.userId, userId),
        eq(schema.message.role, 'user'),
        previous ? gte(schema.message.position, previous.firstKeptPosition) : undefined,
      ),
    );
  return Number(turns?.count ?? 0) >= 2;
}
