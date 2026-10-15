import type { schema } from '@oci/db';
import type { ThreadSummary } from '@oci/shared';
import { classificationMode } from './classification/config.js';
import { loadClassesForThreads } from './classification/resolve.js';

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

/**
 * Conversations as lists show them, with the data classes each carries
 * (`dataClasses`, v0.14). While classification is off nothing is read and the
 * field is absent, so a list costs exactly what it did in v0.13.
 */
export async function serializeThreads(
  threads: Array<typeof schema.thread.$inferSelect>,
): Promise<ThreadSummary[]> {
  const summaries = threads.map(serializeThread);
  if (threads.length === 0 || (await classificationMode()) === 'off') return summaries;
  const classes = await loadClassesForThreads(threads.map((thread) => thread.id));
  return summaries.map((summary) => ({
    ...summary,
    dataClasses: (classes.get(summary.id) ?? []).map(({ id, name, reasons }) => ({
      id,
      name,
      reasons,
    })),
  }));
}

/** One conversation, as `serializeThreads` shows it. */
export async function serializeThreadWithClasses(
  thread: typeof schema.thread.$inferSelect,
): Promise<ThreadSummary> {
  return (await serializeThreads([thread]))[0]!;
}
