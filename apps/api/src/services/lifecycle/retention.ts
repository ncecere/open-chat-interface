import { and, eq, isNull, lte, notInArray, or, schema, sql } from '@oci/db';
import { PROTECTED_AUDIT_ACTIONS } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { exportCursor } from '../compliance/cursor.js';
import { notOnLegalHold } from '../compliance/holds.js';
import { getSetting } from '../settings.js';
import { lockLifecycleOwner } from './owner-lock.js';
import { getRetentionSettings } from './settings.js';
import { trashLockedThread } from './trash-thread.js';

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
    // People on legal hold keep everything until the hold is lifted.
    notOnLegalHold(schema.thread.userId),
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

  // This discovery statement commits before acquiring any owner lock. Its
  // short-lived row locks skip busy owners AND threads before limiting; neither
  // lock may wait while holding the other. Actual mutations reacquire parent-first.
  // Drizzle's builder retains only one FOR clause, hence the explicit SQL here.
  const candidates = await db.execute<{ id: string; userId: string }>(sql`
    select ${schema.thread.id} as id, ${schema.thread.userId} as "userId"
    from ${schema.thread}
    inner join ${schema.user} on ${schema.user.id} = ${schema.thread.userId}
    where ${and(...conditions)}
    order by ${schema.thread.createdAt}, ${schema.thread.id}
    limit ${BATCH_SIZE}
    for key share of ${schema.user} skip locked
    for update of ${schema.thread} skip locked
  `);

  let expired = 0;
  for (const candidate of candidates) {
    const changed = await db.transaction(async (tx) => {
      if (!(await lockLifecycleOwner(tx, candidate.userId, true))) return false;
      const [thread] = await tx
        .select({
          id: schema.thread.id,
          userId: schema.thread.userId,
          organizationId: schema.thread.organizationId,
        })
        .from(schema.thread)
        .where(
          and(
            ...conditions,
            eq(schema.thread.id, candidate.id),
            eq(schema.thread.userId, candidate.userId),
          ),
        )
        .for('update', { skipLocked: true });
      if (!thread) return false;
      await trashLockedThread(tx, thread, 'retention', now);
      return true;
    });
    // Each thread commits separately. An interrupted batch keeps completed work;
    // retries select only still-live eligible threads and cannot double-adjust it.
    if (changed) expired++;
  }

  if (expired > 0) {
    logger.info({ count: expired }, 'Moved inactive conversations to trash');
  }
  return expired;
}

/**
 * Prunes usage history.
 *
 * The daily rollup is the long-lived record; events exist so a rolling or
 * non-UTC calendar window can be evaluated exactly, and only recent ones are
 * ever read for that. Pending and unknown rows are never pruned: a producer may
 * still report usage, and amendments need the event's identity and price snapshot.
 * Nor are the events of people on legal hold: they record what each person
 * used, when and with which model.
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
        // Preserve both active runs and unresolved accounting identities.
        eq(schema.usageEvent.pending, false),
        eq(schema.usageEvent.usageUnknown, false),
        notOnLegalHold(schema.usageEvent.userId),
      ),
    )
    .returning({ id: schema.usageEvent.id });

  return removed.length;
}

/**
 * Prunes audit history, retaining security-relevant actions regardless of age.
 * Those are the entries an incident review needs and they are low volume.
 *
 * Also kept: entries by or about a person on legal hold (including deletion
 * events for their data, which name them as `metadata.deletion.ownerUserId`),
 * and, while the compliance export is on, entries it has not exported yet, so
 * retention can never open a gap in the export.
 */
export async function pruneAuditLog(now: Date = new Date()): Promise<number> {
  const { auditLogRetentionDays } = await getRetentionSettings();
  const cutoff = daysAgo(auditLogRetentionDays, now);
  const exportOn = (await getSetting('compliance'))?.enabled === true;
  const exported = exportOn ? ((await exportCursor('audit')) ?? 0) : null;

  const removed = await db
    .delete(schema.auditLog)
    .where(
      and(
        lte(schema.auditLog.createdAt, cutoff),
        // Drizzle expands an interpolated array into a parameter list, which
        // PostgreSQL rejects for `<> all(...)`; this always failed at runtime.
        notInArray(schema.auditLog.action, [...PROTECTED_AUDIT_ACTIONS]),
        exported === null ? undefined : lte(schema.auditLog.seq, exported),
        sql`not exists (select 1 from ${schema.legalHold}
          where ${schema.legalHold.liftedAt} is null
            and (${schema.legalHold.userId} = ${schema.auditLog.actorUserId}
              or (${schema.auditLog.targetType} = 'user'
                and ${schema.legalHold.userId} = ${schema.auditLog.targetId})
              or ${schema.legalHold.userId} = ${schema.auditLog.metadata}->'deletion'->>'ownerUserId'))`,
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

/**
 * Removes expired and long-revoked share links, except those of people on
 * legal hold: a link records what was shared, when and how often it was read.
 */
export async function pruneShareLinks(now: Date = new Date()): Promise<number> {
  const cutoff = daysAgo(30, now);

  const removed = await db
    .delete(schema.shareLink)
    .where(
      and(
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
        notOnLegalHold(schema.shareLink.userId),
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
