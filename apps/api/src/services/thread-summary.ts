import type { schema } from '@oci/db';
import type { ThreadSummary } from '@oci/shared';

/**
 * A conversation as lists and the sidebar show it. Its own module so the
 * thread routes and the projects service (the sidebar's project tree) share
 * one shape without importing each other.
 */
export function serializeThread(thread: typeof schema.thread.$inferSelect): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned,
    archived: thread.archived,
    temporary: thread.temporary,
    expiresAt: thread.expiresAt?.toISOString() ?? null,
    parentThreadId: thread.parentThreadId,
    branchedFromMessageId: thread.branchedFromMessageId,
    projectId: thread.projectId,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}
