import { and, asc, desc, eq, ilike, schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { getDefaultOrganizationId } from './organization.js';

export async function listThreads(
  userId: string,
  options?: { search?: string; archived?: boolean },
) {
  const conditions = [
    eq(schema.thread.userId, userId),
    eq(schema.thread.archived, options?.archived ?? false),
  ];

  if (options?.search) {
    conditions.push(ilike(schema.thread.title, `%${options.search}%`));
  }

  return db
    .select()
    .from(schema.thread)
    .where(and(...conditions))
    .orderBy(desc(schema.thread.pinned), desc(schema.thread.updatedAt))
    .limit(200);
}

export async function createThread(userId: string, title?: string) {
  const organizationId = await getDefaultOrganizationId();

  const [thread] = await db
    .insert(schema.thread)
    .values({ organizationId, userId, title: title?.trim() || 'New Chat' })
    .returning();

  if (!thread) throw new Error('Failed to create thread');
  return thread;
}

export async function getOwnedThread(threadId: string, userId: string) {
  const [thread] = await db
    .select()
    .from(schema.thread)
    .where(and(eq(schema.thread.id, threadId), eq(schema.thread.userId, userId)))
    .limit(1);

  if (!thread) throw notFound('Thread not found');
  return thread;
}

export async function listMessages(threadId: string) {
  return db
    .select()
    .from(schema.message)
    .where(eq(schema.message.threadId, threadId))
    .orderBy(asc(schema.message.position));
}

export async function nextPosition(threadId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(max(${schema.message.position}), -1)::int` })
    .from(schema.message)
    .where(eq(schema.message.threadId, threadId));

  return (row?.value ?? -1) + 1;
}

export async function touchThread(threadId: string) {
  await db
    .update(schema.thread)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.thread.id, threadId));
}

/** Derives a thread title from the first user message. */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 48) return cleaned || 'New Chat';
  return `${cleaned.slice(0, 48).trimEnd()}...`;
}
