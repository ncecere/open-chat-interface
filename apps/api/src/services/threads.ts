import { and, asc, type Database, desc, eq, ilike, isNull, lte, or, schema, sql } from '@oci/db';
import type { BranchMessageInput, ForkMessageInput, UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { containsPattern } from '../lib/like.js';
import { copyArtifactsToFork } from './artifacts/store.js';
import { copyCompactionToFork } from './chat/compaction-fork.js';
import { activeMessage, latestTurnReplies, pathThrough } from './chat/reply-path.js';
import { notOnLegalHold } from './compliance/holds.js';
import { destroyThreads } from './lifecycle/destroy.js';
import { assertRoleFeature } from './role-features.js';
import { getSetting } from './settings.js';

export const TEMPORARY_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

export async function assertTemporaryChatAllowed(role: UserRole): Promise<void> {
  await assertRoleFeature(role, 'temporaryChat');

  const features = await getSetting('features');
  if (!features.temporaryChat) {
    throw validationFailed('Temporary chat is disabled on this instance');
  }
}

/** Forks and edit-branches need both the role and the instance to allow branching. */
export async function assertBranchingAllowed(role: UserRole): Promise<void> {
  await assertRoleFeature(role, 'branching');

  const features = await getSetting('features');
  if (!features.branching) throw forbidden('Conversation branching is disabled');
}

/**
 * Hard-deletes expired temporary chats.
 *
 * These deliberately skip the trash. A conversation the user was told would
 * vanish in 24 hours must not linger for another month in a recovery bin.
 */
export async function purgeExpiredTemporaryThreads(now = new Date()): Promise<number> {
  const expired = await destroyThreads(
    and(
      eq(schema.thread.temporary, true),
      lte(schema.thread.expiresAt, now),
      // Kept (still invisible to their owner) while the owner is on legal hold.
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'temporary_expiry', actorUserId: null, skipLocked: true, all: true },
  );

  return expired.length;
}

export async function listThreads(
  userId: string,
  options?: {
    search?: string;
    archived?: boolean;
    projectId?: string;
    /**
     * The sidebar's general list: conversations in no project, plus pinned
     * ones wherever they are (the sidebar keeps every pinned conversation in
     * its Pinned section). Project conversations are listed per project.
     */
    outsideProjects?: boolean;
  },
) {
  // Expiry cleanup belongs to the background job runner. Doing it here made an
  // ordinary read perform unbounded deletion work on someone else's rows.
  const conditions = [
    eq(schema.thread.userId, userId),
    eq(schema.thread.archived, options?.archived ?? false),
    eq(schema.thread.temporary, false),
    // Trashed conversations are invisible everywhere a live one would appear.
    isNull(schema.thread.deletedAt),
  ];

  if (options?.search) {
    conditions.push(ilike(schema.thread.title, containsPattern(options.search)));
  }

  // The caller checks that the project is the user's own.
  if (options?.projectId) {
    conditions.push(eq(schema.thread.projectId, options.projectId));
  }

  if (options?.outsideProjects) {
    const unfiled = or(isNull(schema.thread.projectId), eq(schema.thread.pinned, true));
    if (unfiled) conditions.push(unfiled);
  }

  return db
    .select()
    .from(schema.thread)
    .where(and(...conditions))
    .orderBy(desc(schema.thread.pinned), desc(schema.thread.updatedAt))
    .limit(200);
}

/** Where a history page ends: the last row's update time (to the millisecond) and id. */
export interface ThreadHistoryCursor {
  updatedAt: Date;
  id: string;
}

export function encodeThreadHistoryCursor(thread: { updatedAt: Date; id: string }): string {
  return `${thread.updatedAt.toISOString()}|${thread.id}`;
}

/** Null for anything that is not a cursor this API issued. */
export function decodeThreadHistoryCursor(value: string): ThreadHistoryCursor | null {
  const separator = value.indexOf('|');
  if (separator < 0) return null;
  const updatedAt = new Date(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || !id || id.length > 200) return null;
  return { updatedAt, id };
}

/**
 * Settings → History (v0.9.1): every live conversation, a page at a time.
 *
 * Ordered by last update then id, newest first, without the sidebar's pinned
 * grouping, so a cursor (the last row's update time and id) always continues
 * exactly where the previous page stopped. Update times are compared to the
 * millisecond because that is what the cursor can carry.
 */
export async function listThreadHistory(
  userId: string,
  options: { search?: string; archived?: boolean; before?: ThreadHistoryCursor; limit: number },
) {
  const updatedMs = sql`date_trunc('milliseconds', ${schema.thread.updatedAt})`;
  const conditions = [
    eq(schema.thread.userId, userId),
    eq(schema.thread.archived, options.archived ?? false),
    eq(schema.thread.temporary, false),
    isNull(schema.thread.deletedAt),
  ];
  if (options.search) conditions.push(ilike(schema.thread.title, containsPattern(options.search)));
  if (options.before) {
    conditions.push(
      sql`(${updatedMs}, ${schema.thread.id}) < (${options.before.updatedAt.toISOString()}::timestamptz, ${options.before.id})`,
    );
  }
  const rows = await db
    .select()
    .from(schema.thread)
    .where(and(...conditions))
    .orderBy(sql`${updatedMs} desc`, desc(schema.thread.id))
    .limit(options.limit + 1);
  const threads = rows.slice(0, options.limit);
  const last = threads.at(-1);
  return {
    threads,
    nextCursor: rows.length > options.limit && last ? encodeThreadHistoryCursor(last) : null,
  };
}

export async function createThread(options: {
  userId: string;
  organizationId: string;
  role: UserRole;
  title?: string;
  temporary?: boolean;
  /** Start inside one of the user's projects; needs the role's projects feature. */
  projectId?: string;
}) {
  if (options.temporary) await assertTemporaryChatAllowed(options.role);
  if (options.projectId) {
    await assertRoleFeature(options.role, 'projects');
    if (options.temporary) throw validationFailed('Temporary chats cannot be added to a project');
  }

  const values = {
    organizationId: options.organizationId,
    userId: options.userId,
    title: options.title?.trim() || 'New Chat',
    temporary: options.temporary ?? false,
    expiresAt: options.temporary ? new Date(Date.now() + TEMPORARY_THREAD_TTL_MS) : null,
    projectId: options.projectId ?? null,
  };
  const projectId = options.projectId;

  const [thread] = projectId
    ? await db.transaction(async (tx) => {
        // Another person's project is reported as missing, never joined.
        const [project] = await tx
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, options.userId)))
          .for('key share');
        if (!project) throw notFound('Project not found');
        return tx.insert(schema.thread).values(values).returning();
      })
    : await db.insert(schema.thread).values(values).returning();

  if (!thread) throw new Error('Failed to create thread');
  return thread;
}

export async function getOwnedThread(threadId: string, userId: string) {
  const [thread] = await db
    .select()
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        isNull(schema.thread.deletedAt),
      ),
    )
    .limit(1);

  if (!thread) throw notFound('Thread not found');

  if (thread.temporary && (!thread.expiresAt || thread.expiresAt.getTime() <= Date.now())) {
    // Deleted now rather than at the next purge, except under legal hold,
    // where it is kept (and stays invisible) like any other expired chat.
    await destroyThreads(
      and(
        eq(schema.thread.id, thread.id),
        eq(schema.thread.temporary, true),
        notOnLegalHold(schema.thread.userId),
      ),
      { reason: 'temporary_expiry', actorUserId: null },
    );
    throw notFound('Temporary chat has expired');
  }

  return thread;
}

/**
 * Forks an owned conversation through one selected user or assistant message.
 * The source remains immutable; copied rows retain their source IDs as lineage
 * metadata while receiving new primary keys in the child thread.
 */
export async function forkFromMessage(threadId: string, userId: string, input: ForkMessageInput) {
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
    const selected = sourceMessages.find((message) => message.id === input.messageId);
    if (!selected) throw notFound('Message not found');
    if (selected.status === 'streaming') {
      throw validationFailed('A response cannot be forked while it is still streaming');
    }

    const [fork] = await tx
      .insert(schema.thread)
      .values({
        organizationId: sourceThread.organizationId,
        userId,
        title: sourceThread.title,
        parentThreadId: sourceThread.id,
        branchedFromMessageId: selected.id,
        temporary: sourceThread.temporary,
        expiresAt: sourceThread.expiresAt,
        // A fork or edit stays in the project its source belongs to.
        projectId: sourceThread.projectId,
        lastMessageAt: new Date(),
      })
      .returning();
    if (!fork) throw new Error('Failed to create fork');

    // The fork reads as the conversation did through the selected message:
    // one reply per turn, never the alternatives a retry left behind.
    const copiedMessages = pathThrough(sourceMessages, selected.id) ?? [];
    const copies = await tx
      .insert(schema.message)
      .values(
        copiedMessages.map((message) => ({
          threadId: fork.id,
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
      )
      .returning({ id: schema.message.id, sourceId: schema.message.parentMessageId });
    const copied = new Map(copies.map((copy) => [copy.sourceId!, copy.id]));
    await copyCompactionToFork(tx, {
      sourceThreadId: sourceThread.id,
      threadId: fork.id,
      userId,
      copied,
    });
    await copyArtifactsToFork(tx, {
      sourceThreadId: sourceThread.id,
      threadId: fork.id,
      userId,
      copied,
    });

    return fork;
  });
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
        // A fork or edit stays in the project its source belongs to.
        projectId: sourceThread.projectId,
        lastMessageAt: new Date(),
      })
      .returning();

    if (!branch) throw new Error('Failed to create branch');

    const priorMessages = sourceMessages
      .slice(0, selectedIndex)
      .filter((message) => message.supersededAt === null);
    if (priorMessages.length > 0) {
      const copies = await tx
        .insert(schema.message)
        .values(
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
        )
        .returning({ id: schema.message.id, sourceId: schema.message.parentMessageId });
      const copied = new Map(copies.map((copy) => [copy.sourceId!, copy.id]));
      await copyCompactionToFork(tx, {
        sourceThreadId: sourceThread.id,
        threadId: branch.id,
        userId,
        copied,
      });
      await copyArtifactsToFork(tx, {
        sourceThreadId: sourceThread.id,
        threadId: branch.id,
        userId,
        copied,
      });
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

/** The conversation as it reads: one active reply per turn, in order. */
export async function listMessages(threadId: string) {
  return db
    .select()
    .from(schema.message)
    .where(and(eq(schema.message.threadId, threadId), activeMessage()))
    .orderBy(asc(schema.message.position));
}

/**
 * The active conversation plus, when the latest turn was retried, every reply
 * to it (oldest first) so the reader can switch between them. Superseded
 * replies to earlier turns are never returned: they cannot be switched to.
 */
export async function listConversation(threadId: string) {
  const rows = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.threadId, threadId))
    .orderBy(asc(schema.message.position), asc(schema.message.createdAt), asc(schema.message.id));
  return {
    messages: rows.filter((row) => row.supersededAt === null),
    replies: latestTurnReplies(rows),
  };
}

/** Allocating this position requires holding the thread row lock in the same transaction. */
export async function nextPosition(
  threadId: string,
  executor: Pick<Database, 'select'> = db,
): Promise<number> {
  const [row] = await executor
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
