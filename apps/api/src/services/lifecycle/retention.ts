import { and, eq, isNull, lte, or, schema, sql } from '@oci/db';
import { PROTECTED_AUDIT_ACTIONS } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { getRetentionSettings } from './settings.js';

const BATCH_SIZE = 500;

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Moves inactive conversations to the trash.
 *
 * Retention deletes softly rather than destroying immediately, so a policy set
 * too aggressively costs an operator an apology instead of their users' data.
 * The trash window then applies on top, giving a second chance to notice.
 *
 * Pinned threads are exempt when configured: the user explicitly marked them.
 * Shared threads are not exempt, because that would turn sharing into a
 * permanent retention bypass.
 */
export async function applyThreadRetention(now: Date = new Date()): Promise<number> {
  const { threadRetentionDays, exemptPinnedThreads } = await getRetentionSettings();
  if (!threadRetentionDays) return 0;

  const cutoff = daysAgo(threadRetentionDays, now);
  const conditions = [
    isNull(schema.thread.deletedAt),
    eq(schema.thread.temporary, false),
    // Inactivity is measured by the last message, falling back to creation for
    // a thread that never received one.
    or(
      and(
        sql`${schema.thread.lastMessageAt} is not null`,
        lte(schema.thread.lastMessageAt, cutoff),
      ),
      and(sql`${schema.thread.lastMessageAt} is null`, lte(schema.thread.createdAt, cutoff)),
    ),
  ];

  if (exemptPinnedThreads) conditions.push(eq(schema.thread.pinned, false));

  const expired = await db
    .update(schema.thread)
    .set({ deletedAt: now, deletedReason: 'retention' })
    .where(
      and(
        ...conditions,
        sql`${schema.thread.id} in (
          select id from thread
          where deleted_at is null and temporary = false
          limit ${BATCH_SIZE}
        )`,
      ),
    )
    .returning({ id: schema.thread.id });

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Moved inactive conversations to trash');
  }
  return expired.length;
}

/**
 * Prunes usage history.
 *
 * The daily rollup is the long-lived record; events exist so a rolling or
 * non-UTC calendar window can be evaluated exactly, and only recent ones are
 * ever read for that. Pending rows are never pruned: one belongs to a run that
 * may still be streaming.
 */
export async function pruneUsageEvents(now: Date = new Date()): Promise<number> {
  const { usageEventRetentionDays } = await getRetentionSettings();

  // Never prune inside a window some policy still evaluates, or enforcement
  // would silently reset when history disappeared underneath it.
  const [longest] = await db
    .select({
      hours: sql<number>`coalesce(max(case
        when ${schema.quotaPolicy.windowKind} = 'rolling' then ${schema.quotaPolicy.windowHours}
        when ${schema.quotaPolicy.windowKind} = 'daily' then 24
        when ${schema.quotaPolicy.windowKind} = 'weekly' then 168
        when ${schema.quotaPolicy.windowKind} = 'monthly' then 744
        else 24 end), 24)::int`,
    })
    .from(schema.quotaPolicy)
    .where(eq(schema.quotaPolicy.enabled, true));

  const windowDays = Math.ceil(Number(longest?.hours ?? 24) / 24) + 1;
  const retentionDays = Math.max(usageEventRetentionDays, windowDays);
  const cutoff = daysAgo(retentionDays, now);

  const removed = await db
    .delete(schema.usageEvent)
    .where(
      and(
        lte(schema.usageEvent.occurredAt, cutoff),
        // A pending row may belong to a run that is still going.
        eq(schema.usageEvent.pending, false),
      ),
    )
    .returning({ id: schema.usageEvent.id });

  return removed.length;
}

/**
 * Prunes audit history, retaining security-relevant actions regardless of age.
 * Those are the entries an incident review needs and they are low volume.
 */
export async function pruneAuditLog(now: Date = new Date()): Promise<number> {
  const { auditLogRetentionDays } = await getRetentionSettings();
  const cutoff = daysAgo(auditLogRetentionDays, now);

  const removed = await db
    .delete(schema.auditLog)
    .where(
      and(
        lte(schema.auditLog.createdAt, cutoff),
        sql`${schema.auditLog.action} <> all(${[...PROTECTED_AUDIT_ACTIONS]})`,
      ),
    )
    .returning({ id: schema.auditLog.id });

  return removed.length;
}

/**
 * Removes lapsed quota overrides.
 *
 * Purely housekeeping: enforcement already filters on the expiry when it reads
 * a limit, so an override stops applying the moment it lapses rather than when
 * this runs. Deleting only keeps the table from accumulating dead rows.
 */
export async function pruneExpiredQuotaOverrides(now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(schema.quotaPolicyOverride)
    .where(
      and(
        sql`${schema.quotaPolicyOverride.expiresAt} is not null`,
        lte(schema.quotaPolicyOverride.expiresAt, daysAgo(7, now)),
      ),
    )
    .returning({ id: schema.quotaPolicyOverride.id });

  return removed.length;
}

/** Removes expired and long-revoked share links. */
export async function pruneShareLinks(now: Date = new Date()): Promise<number> {
  const cutoff = daysAgo(30, now);

  const removed = await db
    .delete(schema.shareLink)
    .where(
      or(
        and(
          sql`${schema.shareLink.expiresAt} is not null`,
          lte(schema.shareLink.expiresAt, cutoff),
        ),
        and(
          sql`${schema.shareLink.revokedAt} is not null`,
          lte(schema.shareLink.revokedAt, cutoff),
        ),
      ),
    )
    .returning({ id: schema.shareLink.id });

  return removed.length;
}

/**
 * Removes expired sessions, verification tokens, and spent invitations. All
 * three are already refused at read time; this stops them accumulating.
 */
export async function pruneAuthArtifacts(now: Date = new Date()): Promise<number> {
  const sessions = await db
    .delete(schema.session)
    .where(lte(schema.session.expiresAt, daysAgo(7, now)))
    .returning({ id: schema.session.id });

  const verifications = await db
    .delete(schema.verification)
    .where(lte(schema.verification.expiresAt, daysAgo(7, now)))
    .returning({ id: schema.verification.id });

  const invitations = await db
    .delete(schema.invitation)
    .where(
      or(
        and(
          sql`${schema.invitation.expiresAt} is not null`,
          lte(schema.invitation.expiresAt, daysAgo(30, now)),
        ),
        and(
          sql`${schema.invitation.redeemedAt} is not null`,
          lte(schema.invitation.redeemedAt, daysAgo(30, now)),
        ),
      ),
    )
    .returning({ id: schema.invitation.id });

  return sessions.length + verifications.length + invitations.length;
}
