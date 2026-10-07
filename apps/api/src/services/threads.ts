import { and, asc, type Database, desc, eq, gte, isNull, lte, or, schema, sql } from '@oci/db';
import {
  type BranchMessageInput,
  type ForkMessageInput,
  THREAD_TITLE_MAX_LENGTH,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { forbidden, notFound, rateLimited, validationFailed } from '../lib/errors.js';
import { foldedIlike } from '../lib/fold.js';
import { containsPattern } from '../lib/like.js';
import { copyArtifactsToFork } from './artifacts/store.js';
import { copyCompactionToFork } from './chat/compaction-fork.js';
import { editedQuestionParts } from './chat/message-parts.js';
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

/** The title of a conversation until its first message names it. */
const UNTITLED = 'New Chat';

/** A conversation nobody has written in: still untitled, without a single message. */
function unused() {
  return and(
    eq(schema.thread.title, UNTITLED),
    sql`not exists (select 1 from ${schema.message}
      where ${schema.message.threadId} = ${schema.thread.id})`,
  );
}

/**
 * How many unused (untitled, message-less) conversations one person may have
 * started in the last minute before another untitled one is refused
 * (v0.10.2, POST /api/threads only).
 *
 * The home page creates a conversation and its first message follows within
 * a second, so normal use leaves at most one unused at a time; one is left
 * behind only when that hand-over fails. Ten in a minute means a client is
 * looping, as in v0.10.1, when one send created 16,389 of them. This is a
 * backstop under the per-person rate limit, counted in PostgreSQL, so it
 * holds even when Redis is down and replicas count separately.
 */
export const MAX_RECENT_UNUSED_THREADS = 10;
const UNUSED_WINDOW_MS = 60_000;
export const UNUSED_THREADS_MESSAGE =
  'You have started several conversations without sending anything. Wait a minute, then try again.';

/** Refuses a request for another untitled conversation; see MAX_RECENT_UNUSED_THREADS. */
export async function assertNotLeavingUnusedThreads(
  userId: string,
  title: string | undefined,
  now = new Date(),
): Promise<void> {
  // Only an untitled conversation can be another unused one.
  if ((title?.trim() || UNTITLED) !== UNTITLED) return;
  const since = new Date(now.getTime() - UNUSED_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.userId, userId),
        // Unused conversations are never updated, so this bound uses the
        // (user_id, updated_at) index.
        gte(schema.thread.updatedAt, since),
        gte(schema.thread.createdAt, since),
        isNull(schema.thread.deletedAt),
        unused(),
      ),
    );
  if ((row?.count ?? 0) >= MAX_RECENT_UNUSED_THREADS) {
    throw rateLimited(UNUSED_THREADS_MESSAGE, Math.ceil(UNUSED_WINDOW_MS / 1000));
  }
}

/** How long an unused conversation is kept before the cleanup job removes it. */
export const UNUSED_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes conversations that were started and never used: still untitled,
 * without a message, untouched for a day (v0.10.2). They are left behind when
 * the hand-over from the home page to a new conversation fails, and hold
 * nothing to keep. Pinned, archived, trashed (the trash purges those),
 * imported and temporary ones (they expire on their own) are left alone, as
 * is everything of a person on legal hold.
 */
export async function purgeUnusedThreads(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNUSED_THREAD_TTL_MS);
  const removed = await destroyThreads(
    and(
      unused(),
      lte(schema.thread.createdAt, cutoff),
      lte(schema.thread.updatedAt, cutoff),
      isNull(schema.thread.lastMessageAt),
      eq(schema.thread.pinned, false),
      eq(schema.thread.archived, false),
      eq(schema.thread.temporary, false),
      isNull(schema.thread.deletedAt),
      isNull(schema.thread.importSource),
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'unused_expiry', actorUserId: null, skipLocked: true, all: true },
  );
  return removed.length;
}

/**
 * Destroys one of the person's conversations if it is still unused (untitled,
 * without a message), as the daily cleanup would, but at once: the page that
 * started it calls this when the person leaves after its first message was
 * refused (a server restarting, a rate limit), so no empty "New Chat" is left
 * in their history (#234). Holds nothing to keep, so it skips the trash. A
 * conversation that has a message by now (a send that was accepted after
 * all; the turn's transaction locks the conversation as this does) is kept.
 */
export async function destroyUnusedThread(threadId: string, userId: string): Promise<boolean> {
  const removed = await destroyThreads(
    and(
      eq(schema.thread.id, threadId),
      eq(schema.thread.userId, userId),
      unused(),
      isNull(schema.thread.lastMessageAt),
      eq(schema.thread.pinned, false),
      eq(schema.thread.archived, false),
      isNull(schema.thread.deletedAt),
      isNull(schema.thread.importSource),
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'unused_expiry', actorUserId: userId },
  );
  return removed.length > 0;
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
    // Accents do not matter: "bibliotheque" finds "bibliothèque" (#362).
    conditions.push(foldedIlike(sql`${schema.thread.title}`, containsPattern(options.search)));
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
  const title = options.title?.trim() || UNTITLED;

  const values = {
    organizationId: options.organizationId,
    userId: options.userId,
    title,
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
        title: forkTitle(sourceThread.title),
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
    await copyMessagesInto(tx, {
      sourceThreadId: sourceThread.id,
      threadId: fork.id,
      userId,
      messages: pathThrough(sourceMessages, selected.id) ?? [],
    });

    return fork;
  });
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Copies messages into a fork or edit as new rows that keep their source ids
 * as lineage, with the compaction summary and artifacts made along them.
 */
async function copyMessagesInto(
  tx: Transaction,
  input: {
    sourceThreadId: string;
    threadId: string;
    userId: string;
    messages: (typeof schema.message.$inferSelect)[];
  },
) {
  if (input.messages.length === 0) return;
  const copies = await tx
    .insert(schema.message)
    .values(
      input.messages.map((message) => ({
        threadId: input.threadId,
        userId: input.userId,
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
  const target = {
    sourceThreadId: input.sourceThreadId,
    threadId: input.threadId,
    userId: input.userId,
    copied: new Map(copies.map((copy) => [copy.sourceId!, copy.id])),
  };
  await copyCompactionToFork(tx, target);
  await copyArtifactsToFork(tx, target);
}

/**
 * A fork's title: its source's, marked, so the two can be told apart in the
 * sidebar, which shows the start of a long title (#213). A fork of a fork is
 * not marked twice.
 */
export function forkTitle(title: string): string {
  if (title.startsWith(FORK_PREFIX)) return title;
  return `${FORK_PREFIX}${title}`.slice(0, THREAD_TITLE_MAX_LENGTH);
}
const FORK_PREFIX = 'Fork of ';

/**
 * The fork's copy of the message it was made at: a fork made at a question
 * is answered at once, as an edit is (#213).
 */
export async function forkedMessage(forkId: string, sourceMessageId: string) {
  const [copy] = await db
    .select({
      id: schema.message.id,
      role: schema.message.role,
      modelSlug: schema.message.modelSlug,
      effort: schema.message.effort,
    })
    .from(schema.message)
    .where(
      and(eq(schema.message.threadId, forkId), eq(schema.message.parentMessageId, sourceMessageId)),
    )
    .limit(1);
  if (!copy) throw notFound('Message not found');
  return copy;
}

/**
 * Creates an immutable edit branch from a user turn. History is copied only
 * from server-owned rows; the replacement is the validated text with the
 * question's own files (see `editedQuestionParts`).
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
    const parts = editedQuestionParts(selected.parts, input.text, input.attachmentIds);

    const [branch] = await tx
      .insert(schema.thread)
      .values({
        organizationId: sourceThread.organizationId,
        userId,
        // From the revised question wherever it sits: keeping the source's title
        // listed identical rows, as a fixed "Edit of" mark still would (#278).
        title: deriveTitle(input.text),
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

    await copyMessagesInto(tx, {
      sourceThreadId: sourceThread.id,
      threadId: branch.id,
      userId,
      messages: sourceMessages
        .slice(0, selectedIndex)
        .filter((message) => message.supersededAt === null),
    });

    const [replacement] = await tx
      .insert(schema.message)
      .values({
        threadId: branch.id,
        userId,
        role: 'user',
        parts,
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

const TITLE_MAX = 60;

/**
 * Derives a thread title from the first user message: whole words, up to 60
 * characters, and no "..." (#100). The title is stored and shows on share
 * pages, in History and in export file names, so a cut word or an ellipsis
 * stays with it; lists shorten it on screen anyway.
 */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= TITLE_MAX) return cleaned || 'New Chat';
  const head = cleaned.slice(0, TITLE_MAX + 1);
  const space = head.lastIndexOf(' ');
  // One very long word (a URL, say) is cut where it must be.
  const cut = space >= TITLE_MAX / 2 ? head.slice(0, space) : head.slice(0, TITLE_MAX);
  return cut.replace(/[\s,;:–—-]+$/u, '');
}
