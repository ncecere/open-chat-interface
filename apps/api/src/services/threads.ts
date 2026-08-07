import { and, asc, desc, eq, ilike, lte, schema, sql } from '@oci/db';
import type { BranchMessageInput, UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { getSetting } from './settings.js';

export const TEMPORARY_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

export async function assertTemporaryChatAllowed(role: UserRole): Promise<void> {
  if (role === 'restricted') {
    throw forbidden('Your role does not allow temporary chats');
  }

  const features = await getSetting('features');
  if (!features.temporaryChat) {
    throw validationFailed('Temporary chat is disabled on this instance');
  }
}

/**
 * PostgreSQL has no built-in row TTL. This bounded cleanup is run periodically
 * by the API process and opportunistically by thread endpoints.
 */
export async function purgeExpiredTemporaryThreads(now = new Date()): Promise<number> {
  const expired = await db
    .delete(schema.thread)
    .where(and(eq(schema.thread.temporary, true), lte(schema.thread.expiresAt, now)))
    .returning({ id: schema.thread.id });

  return expired.length;
}

export async function listThreads(
  userId: string,
  options?: { search?: string; archived?: boolean },
) {
  await purgeExpiredTemporaryThreads();

  const conditions = [
    eq(schema.thread.userId, userId),
    eq(schema.thread.archived, options?.archived ?? false),
    eq(schema.thread.temporary, false),
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

export async function createThread(options: {
  userId: string;
  organizationId: string;
  role: UserRole;
  title?: string;
  temporary?: boolean;
}) {
  if (options.temporary) await assertTemporaryChatAllowed(options.role);

  const [thread] = await db
    .insert(schema.thread)
    .values({
      organizationId: options.organizationId,
      userId: options.userId,
      title: options.title?.trim() || 'New Chat',
      temporary: options.temporary ?? false,
      expiresAt: options.temporary ? new Date(Date.now() + TEMPORARY_THREAD_TTL_MS) : null,
    })
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

  if (thread.temporary && (!thread.expiresAt || thread.expiresAt.getTime() <= Date.now())) {
    await db.delete(schema.thread).where(eq(schema.thread.id, thread.id));
    throw notFound('Temporary chat has expired');
  }

  return thread;
}

/**
 * Creates an immutable edit branch from a user turn. History is copied only
 * from server-owned rows; the replacement is a single validated text part.
 */
export async function branchFromUserMessage(
  threadId: string,
  userId: string,
  input: BranchMessageInput,
) {
  return db.transaction(async (tx) => {
    const [sourceThread] = await tx
      .select()
      .from(schema.thread)
      .where(and(eq(schema.thread.id, threadId), eq(schema.thread.userId, userId)))
      .limit(1);

    if (!sourceThread) throw notFound('Thread not found');

    const sourceMessages = await tx
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, sourceThread.id))
      .orderBy(asc(schema.message.position));
    const selectedIndex = sourceMessages.findIndex((message) => message.id === input.messageId);
    const selected = sourceMessages[selectedIndex];

    if (!selected) throw notFound('Message not found');
    if (selected.role !== 'user') {
      throw validationFailed('Only user messages can be edited');
    }

    const [branch] = await tx
      .insert(schema.thread)
      .values({
        organizationId: sourceThread.organizationId,
        userId,
        title: selectedIndex === 0 ? deriveTitle(input.text) : sourceThread.title,
        parentThreadId: sourceThread.id,
        branchedFromMessageId: selected.id,
        temporary: sourceThread.temporary,
        expiresAt: sourceThread.expiresAt,
        lastMessageAt: new Date(),
      })
      .returning();

    if (!branch) throw new Error('Failed to create branch');

    const priorMessages = sourceMessages.slice(0, selectedIndex);
    if (priorMessages.length > 0) {
      await tx.insert(schema.message).values(
        priorMessages.map((message) => ({
          threadId: branch.id,
          userId,
          role: message.role,
          parts: message.parts,
          position: message.position,
          parentMessageId: message.id,
          modelSlug: message.modelSlug,
          effort: message.effort,
          webSearchUsed: message.webSearchUsed,
          status: message.status,
          errorMessage: message.errorMessage,
          tokensIn: message.tokensIn,
          tokensOut: message.tokensOut,
          durationMs: message.durationMs,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
      );
    }

    const [replacement] = await tx
      .insert(schema.message)
      .values({
        threadId: branch.id,
        userId,
        role: 'user',
        parts: [{ type: 'text', text: input.text }],
        position: selected.position,
        parentMessageId: selected.id,
        modelSlug: selected.modelSlug,
        effort: selected.effort,
        status: 'complete',
      })
      .returning();

    if (!replacement) throw new Error('Failed to create edited message');
    return { thread: branch, message: replacement };
  });
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
