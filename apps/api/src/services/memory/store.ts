import { and, desc, eq, inArray, like, lte, schema, sql } from '@oci/db';
import {
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ENTRIES,
  type MemoryEntry,
  type MemorySource,
  type MemoryState,
  type MemoryToolResult,
  memoryChangeOf,
  normalizeMemoryContent,
  type UndoMemoryInput,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { getRetentionSettings } from '../lifecycle/settings.js';
import { memoryAvailable, memoryOptedIn } from './access.js';

type MemoryRow = typeof schema.userMemory.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** How a change was made, recorded in the audit metadata. */
export type MemoryVia = 'tool' | 'settings' | 'undo' | 'retention';

const UNAVAILABLE = 'Memory is not available. Your administrator has not switched it on for you.';
const LIMIT_REACHED = `You have reached the limit of ${MAX_MEMORY_ENTRIES} memories. Delete some in Settings → Memory first.`;

export function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Audit events carry counts and ids only, never what a memory says: the audit
 * log outlives deleted memories and is read by administrators.
 */
async function auditMemory(
  action: 'memory.add' | 'memory.update' | 'memory.delete' | 'memory.settings.update',
  userId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    actorUserId: userId,
    action,
    targetType: userId ? 'user' : 'instance',
    targetId: userId,
    metadata,
  });
}

/** Serialises one person's writes so the entry limit holds under concurrent requests. */
async function lockOwner(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`oci:user-memory:${userId}`}, 0))`,
  );
}

/** A person's memories, newest (most recently updated) first. */
export async function listMemories(userId: string, limit = MAX_MEMORY_ENTRIES) {
  return db
    .select()
    .from(schema.userMemory)
    .where(eq(schema.userMemory.userId, userId))
    .orderBy(desc(schema.userMemory.updatedAt), desc(schema.userMemory.id))
    .limit(limit);
}

export async function memoryState(user: { id: string; role: UserRole }): Promise<MemoryState> {
  const [enabled, available, rows] = await Promise.all([
    memoryOptedIn(user.id),
    memoryAvailable(user.role),
    listMemories(user.id),
  ]);
  return {
    enabled,
    available,
    entries: rows.map(toMemoryEntry),
    limits: { maxEntries: MAX_MEMORY_ENTRIES, maxChars: MAX_MEMORY_CHARS },
  };
}

/** The person's own switch. Switching on needs the instance and role to allow memory. */
export async function setMemoryEnabled(
  user: { id: string; role: UserRole },
  enabled: boolean,
): Promise<void> {
  if (enabled && !(await memoryAvailable(user.role))) throw forbidden(UNAVAILABLE);
  await db
    .insert(schema.userPreference)
    .values({ userId: user.id, memoryEnabled: enabled })
    .onConflictDoUpdate({
      target: schema.userPreference.userId,
      set: { memoryEnabled: enabled },
    });
  await auditMemory('memory.settings.update', user.id, { enabled });
}

interface AddOrigin {
  source: MemorySource;
  via: MemoryVia;
  threadId?: string | null;
  messageId?: string | null;
  /** Restores a removed memory under its old id (undo). */
  id?: string;
}

/**
 * Saves one memory. The same note (ignoring case and spacing) is never stored
 * twice: the existing entry is returned with `created: false`.
 */
export async function addMemory(
  userId: string,
  content: string,
  origin: AddOrigin,
): Promise<{ row: MemoryRow; created: boolean }> {
  const text = normalizeMemoryContent(content);
  if (!text) throw validationFailed('Write something to remember.');
  if (text.length > MAX_MEMORY_CHARS)
    throw validationFailed(`A memory can be at most ${MAX_MEMORY_CHARS} characters.`);
  const result = await db.transaction(async (tx) => {
    await lockOwner(tx, userId);
    const [same] = await tx
      .select()
      .from(schema.userMemory)
      .where(
        and(
          eq(schema.userMemory.userId, userId),
          origin.id
            ? eq(schema.userMemory.id, origin.id)
            : sql`lower(${schema.userMemory.content}) = lower(${text})`,
        ),
      )
      .limit(1);
    if (same) return { row: same, created: false };
    const [counted] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(schema.userMemory)
      .where(eq(schema.userMemory.userId, userId));
    if ((counted?.value ?? 0) >= MAX_MEMORY_ENTRIES) throw validationFailed(LIMIT_REACHED);
    const [row] = await tx
      .insert(schema.userMemory)
      .values({
        ...(origin.id ? { id: origin.id } : {}),
        userId,
        content: text,
        source: origin.source,
        threadId: origin.threadId ?? null,
        messageId: origin.messageId ?? null,
      })
      .returning();
    return { row: row!, created: true };
  });
  if (result.created)
    await auditMemory('memory.add', userId, {
      count: 1,
      source: origin.source,
      via: origin.via,
      memoryId: result.row.id,
      ...(origin.threadId ? { threadId: origin.threadId } : {}),
      ...(origin.messageId ? { messageId: origin.messageId } : {}),
    });
  return result;
}

/** Changes the text of one of the person's own memories; anyone else's is not found. */
export async function updateMemory(userId: string, id: string, content: string) {
  const text = normalizeMemoryContent(content);
  const [row] = await db
    .update(schema.userMemory)
    .set({ content: text, updatedAt: new Date() })
    .where(and(eq(schema.userMemory.id, id), eq(schema.userMemory.userId, userId)))
    .returning();
  if (!row) throw notFound('Memory not found');
  await auditMemory('memory.update', userId, { count: 1, via: 'settings', memoryId: id });
  return row;
}

/** Deletes one of the person's own memories; returns it, or null when there was none. */
export async function deleteMemory(
  userId: string,
  id: string,
  via: MemoryVia,
  context: { threadId?: string; messageId?: string } = {},
): Promise<MemoryRow | null> {
  const [row] = await db
    .delete(schema.userMemory)
    .where(and(eq(schema.userMemory.id, id), eq(schema.userMemory.userId, userId)))
    .returning();
  if (row) await auditMemory('memory.delete', userId, { count: 1, via, memoryId: id, ...context });
  return row ?? null;
}

export async function deleteAllMemories(userId: string): Promise<number> {
  const removed = await db
    .delete(schema.userMemory)
    .where(eq(schema.userMemory.userId, userId))
    .returning({ id: schema.userMemory.id });
  if (removed.length > 0)
    await auditMemory('memory.delete', userId, { count: removed.length, via: 'settings' });
  return removed.length;
}

/** The short reference the model sees for a memory: the first 8 characters of its id. */
export const memoryRef = (id: string) => id.slice(0, 8);

/** Accepted forms of a reference: hex digits and hyphens, as in a UUID. */
const REF_PATTERN = /^[0-9a-f-]{4,36}$/i;

/** Removes the memory a short reference names, for the `forget` tool. */
export async function forgetMemory(
  userId: string,
  ref: string,
  context: { threadId: string; messageId: string },
): Promise<MemoryToolResult> {
  const value = ref
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!REF_PATTERN.test(value)) throw validationFailed('Use the id shown before the memory.');
  const matches = await db
    .select({ id: schema.userMemory.id })
    .from(schema.userMemory)
    .where(and(eq(schema.userMemory.userId, userId), like(schema.userMemory.id, `${value}%`)))
    .limit(2);
  if (matches.length === 0) throw notFound('There is no memory with that id.');
  if (matches.length > 1) throw validationFailed('That id matches more than one memory.');
  const removed = await deleteMemory(userId, matches[0]!.id, 'tool', context);
  if (!removed) throw notFound('There is no memory with that id.');
  return { action: 'removed', id: removed.id, content: removed.content };
}

/**
 * Reverses one `remember` or `forget` step of the person's own reply: a saved
 * memory is deleted, a forgotten one restored under its old id. Repeating an
 * undo changes nothing.
 */
export async function undoMemoryChange(
  user: { id: string; role: UserRole },
  input: UndoMemoryInput,
): Promise<{ action: 'removed' | 'restored'; changed: boolean }> {
  const [reply] = await db
    .select({
      id: schema.message.id,
      threadId: schema.message.threadId,
      parts: schema.message.parts,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.id, input.messageId),
        eq(schema.message.userId, user.id),
        eq(schema.message.role, 'assistant'),
      ),
    )
    .limit(1);
  if (!reply) throw notFound('Reply not found');
  const part = (Array.isArray(reply.parts) ? reply.parts : []).find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { toolCallId?: unknown }).toolCallId === input.toolCallId,
  ) as Record<string, unknown> | undefined;
  const change = part ? memoryChangeOf(part) : null;
  if (!change) throw validationFailed('This step did not change a memory.');
  if (change.action === 'added') {
    const removed = await deleteMemory(user.id, change.id, 'undo', {
      threadId: reply.threadId,
      messageId: reply.id,
    });
    return { action: 'removed', changed: removed !== null };
  }
  if (!(await memoryAvailable(user.role))) throw forbidden(UNAVAILABLE);
  const restored = await addMemory(user.id, change.content, {
    source: 'tool',
    via: 'undo',
    id: change.id,
    threadId: reply.threadId,
    messageId: reply.id,
  });
  return { action: 'restored', changed: restored.created };
}

const RETENTION_BATCH = 1_000;

/**
 * Deletes memories not updated for the configured number of days (off by
 * default). One audit event per run with the count and how many people it
 * touched; never what was deleted.
 */
export async function applyMemoryRetention(now: Date = new Date()): Promise<number> {
  const { memoryRetentionDays } = await getRetentionSettings();
  if (!memoryRetentionDays) return 0;
  const cutoff = new Date(now.getTime() - memoryRetentionDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  const people = new Set<string>();
  for (;;) {
    const batch = await db
      .select({ id: schema.userMemory.id })
      .from(schema.userMemory)
      .where(lte(schema.userMemory.updatedAt, cutoff))
      .limit(RETENTION_BATCH);
    if (batch.length === 0) break;
    const rows = await db
      .delete(schema.userMemory)
      .where(
        and(
          inArray(
            schema.userMemory.id,
            batch.map((row) => row.id),
          ),
          lte(schema.userMemory.updatedAt, cutoff),
        ),
      )
      .returning({ userId: schema.userMemory.userId });
    removed += rows.length;
    for (const row of rows) people.add(row.userId);
    if (batch.length < RETENTION_BATCH) break;
  }
  if (removed > 0) {
    logger.info({ count: removed }, 'Deleted memories past their retention');
    await auditMemory('memory.delete', null, {
      count: removed,
      people: people.size,
      via: 'retention',
      retentionDays: memoryRetentionDays,
    });
  }
  return removed;
}

/** Refuses adding or editing when the instance or role does not allow memory. */
export async function assertMemoryAvailable(role: UserRole): Promise<void> {
  if (!(await memoryAvailable(role))) throw forbidden(UNAVAILABLE);
}
