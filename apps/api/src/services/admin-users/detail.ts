import { and, count, desc, eq, isNull, or, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { toAdminUser } from './listing.js';

/** Gather account activity, storage usage and security context in a single response. */
export async function getUserDetail(targetId: string) {
  const [target] = await db.select().from(schema.user).where(eq(schema.user.id, targetId)).limit(1);
  if (!target) throw notFound('User not found');

  const [threads, messages, storage, sessions, recentThreads, auditEntries] = await Promise.all([
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
      .where(eq(schema.session.userId, targetId))
      .orderBy(desc(schema.session.createdAt))
      .limit(10),
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
    // Include actions both by and against this account.
    db
      .select()
      .from(schema.auditLog)
      .where(or(eq(schema.auditLog.actorUserId, targetId), eq(schema.auditLog.targetId, targetId)))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(25),
  ]);

  return {
    user: toAdminUser({
      ...target,
      threadCount: threads[0]?.value ?? 0,
      messageCount: messages[0]?.value ?? 0,
    }),
    storage: {
      bytesUsed: Number(storage[0]?.bytes ?? 0),
      fileCount: storage[0]?.files ?? 0,
    },
    sessions: sessions.map((session) => ({
      ...session,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
    recentThreads: recentThreads.map((thread) => ({
      ...thread,
      updatedAt: thread.updatedAt.toISOString(),
    })),
    audit: auditEntries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
