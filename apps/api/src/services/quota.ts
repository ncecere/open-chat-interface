import { and, eq, gte, schema, sql } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { quotaExceeded } from '../lib/errors.js';
import { getDefaultOrganizationId } from './organization.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Throws when the caller's role quota is enabled and already spent. */
export async function checkQuota(userId: string, role: UserRole): Promise<void> {
  const organizationId = await getDefaultOrganizationId();

  const [quota] = await db
    .select()
    .from(schema.roleQuota)
    .where(
      and(eq(schema.roleQuota.organizationId, organizationId), eq(schema.roleQuota.role, role)),
    )
    .limit(1);

  if (!quota?.enabled) return;

  const windowStart = new Date(Date.now() - quota.windowHours * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageRecord.messageCount}), 0)::int`,
      tokens: sql<number>`coalesce(sum(${schema.usageRecord.tokensIn} + ${schema.usageRecord.tokensOut}), 0)::int`,
    })
    .from(schema.usageRecord)
    .where(
      and(eq(schema.usageRecord.userId, userId), gte(schema.usageRecord.createdAt, windowStart)),
    );

  if (quota.maxMessagesPerWindow && (totals?.messages ?? 0) >= quota.maxMessagesPerWindow) {
    throw quotaExceeded(
      `You have reached your limit of ${quota.maxMessagesPerWindow} messages per ${quota.windowHours} hours.`,
    );
  }

  if (quota.maxTokensPerWindow && (totals?.tokens ?? 0) >= quota.maxTokensPerWindow) {
    throw quotaExceeded(
      `You have reached your token limit for the last ${quota.windowHours} hours.`,
    );
  }
}

export interface UsageSummary {
  enabled: boolean;
  windowHours: number;
  /** When the rolling window's oldest counted activity ages out. */
  resetsAt: string | null;
  messages: { used: number; limit: number | null };
  tokens: { used: number; limit: number | null };
}

/** Current-window consumption for the usage meter in settings. */
export async function getUsageSummary(userId: string, role: UserRole): Promise<UsageSummary> {
  const organizationId = await getDefaultOrganizationId();

  const [quota] = await db
    .select()
    .from(schema.roleQuota)
    .where(
      and(eq(schema.roleQuota.organizationId, organizationId), eq(schema.roleQuota.role, role)),
    )
    .limit(1);

  const windowHours = quota?.windowHours ?? 24;
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageRecord.messageCount}), 0)::int`,
      tokens: sql<number>`coalesce(sum(${schema.usageRecord.tokensIn} + ${schema.usageRecord.tokensOut}), 0)::int`,
      oldest: sql<string | null>`min(${schema.usageRecord.createdAt})`,
    })
    .from(schema.usageRecord)
    .where(
      and(eq(schema.usageRecord.userId, userId), gte(schema.usageRecord.createdAt, windowStart)),
    );

  // The window frees up once the oldest counted activity ages out of it.
  const oldest = totals?.oldest ? new Date(totals.oldest) : null;
  const resetsAt = oldest
    ? new Date(oldest.getTime() + windowHours * 60 * 60 * 1000).toISOString()
    : null;

  return {
    enabled: quota?.enabled ?? false,
    windowHours,
    resetsAt,
    messages: { used: totals?.messages ?? 0, limit: quota?.maxMessagesPerWindow ?? null },
    tokens: { used: totals?.tokens ?? 0, limit: quota?.maxTokensPerWindow ?? null },
  };
}

export async function recordUsage(params: {
  userId: string;
  modelSlug: string;
  tokensIn: number;
  tokensOut: number;
}): Promise<void> {
  const organizationId = await getDefaultOrganizationId();
  const day = today();

  const [existing] = await db
    .select({ id: schema.usageRecord.id })
    .from(schema.usageRecord)
    .where(
      and(
        eq(schema.usageRecord.userId, params.userId),
        eq(schema.usageRecord.modelSlug, params.modelSlug),
        eq(schema.usageRecord.day, day),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(schema.usageRecord)
      .set({
        messageCount: sql`${schema.usageRecord.messageCount} + 1`,
        tokensIn: sql`${schema.usageRecord.tokensIn} + ${params.tokensIn}`,
        tokensOut: sql`${schema.usageRecord.tokensOut} + ${params.tokensOut}`,
      })
      .where(eq(schema.usageRecord.id, existing.id));
    return;
  }

  await db.insert(schema.usageRecord).values({
    organizationId,
    userId: params.userId,
    modelSlug: params.modelSlug,
    day,
    messageCount: 1,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
  });
}
