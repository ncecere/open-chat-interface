import { and, count, desc, eq, gt, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { auditEntryAbout } from '../audit-subject.js';
import { activeLegalHold } from '../compliance/holds.js';
import { toAdminUser } from './listing.js';

/** How many of an account's sessions the detail page lists; `sessionCount` is the total. */
export const DETAIL_SESSION_LIMIT = 10;

/** Gather account activity, storage usage and security context in a single response. */
export async function getUserDetail(targetId: string) {
  const [target] = await db.select().from(schema.user).where(eq(schema.user.id, targetId)).limit(1);
  if (!target) throw notFound('User not found');

  // Only unexpired sessions are active. The page lists the newest few and
  // states the total, so an administrator investigating a compromise is not
  // told "10 active sessions" when there are hundreds (#134).
  const activeSession = and(
    eq(schema.session.userId, targetId),
    gt(schema.session.expiresAt, new Date()),
  );
  const [threads, messages, storage, sessions, sessionTotal, recentThreads, auditEntries, hold] =
    await Promise.all([
      db.select({ value: count() }).from(schema.thread).where(eq(schema.thread.userId, targetId)),
      db.select({ value: count() }).from(schema.message).where(eq(schema.message.userId, targetId)),
      db
        .select({ bytes: schema.storageUsage.liveBytes, files: schema.storageUsage.liveFileCount })
        .from(schema.storageUsage)
        .where(eq(schema.storageUsage.userId, targetId))
        .limit(1),
      db
        .select({
          id: schema.session.id,
          createdAt: schema.session.createdAt,
          expiresAt: schema.session.expiresAt,
          ipAddress: schema.session.ipAddress,
          userAgent: schema.session.userAgent,
        })
        .from(schema.session)
        .where(activeSession)
        .orderBy(desc(schema.session.createdAt))
        .limit(DETAIL_SESSION_LIMIT),
      db.select({ value: count() }).from(schema.session).where(activeSession),
      db
        .select({
          id: schema.thread.id,
          title: schema.thread.title,
          updatedAt: schema.thread.updatedAt,
        })
        .from(schema.thread)
        .where(and(eq(schema.thread.userId, targetId), isNull(schema.thread.deletedAt)))
        .orderBy(desc(schema.thread.updatedAt))
        .limit(10),
      // Include actions both by and against this account, bulk ones too (#216).
      db
        .select()
        .from(schema.auditLog)
        .where(auditEntryAbout(targetId))
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(25),
      activeLegalHold(targetId),
    ]);

  return {
    user: toAdminUser({
      ...target,
      threadCount: threads[0]?.value ?? 0,
      messageCount: messages[0]?.value ?? 0,
      legalHold: Boolean(hold),
    }),
    // Shown to administrators and auditors on the account page; null when not held.
    legalHold: hold
      ? { reason: hold.reason, placedAt: hold.placedAt, placedByEmail: hold.placedByEmail }
      : null,
    storage: {
      bytesUsed: Number(storage[0]?.bytes ?? 0),
      fileCount: storage[0]?.files ?? 0,
    },
    sessions: sessions.map((session) => ({
      ...session,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
    sessionCount: sessionTotal[0]?.value ?? 0,
    recentThreads: recentThreads.map((thread) => ({
      ...thread,
      updatedAt: thread.updatedAt.toISOString(),
    })),
    audit: auditEntries.map(({ seq: _seq, ...entry }) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
