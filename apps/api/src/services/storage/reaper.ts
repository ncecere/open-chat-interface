import { and, eq, inArray, isNull, lte, schema, sql } from '@oci/db';
import { BACKUP_STORAGE_PREFIX, COMPLIANCE_STORAGE_PREFIX } from '@oci/shared';
import { db } from '../../db/index.js';
import { errorText } from '../../lib/log-redaction.js';
import { logger } from '../../lib/logger.js';
import { getStorageDriver } from './index.js';

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 200;

/**
 * Objects newer than this are never treated as orphans. An upload writes the
 * blob before committing its row, so a reconciliation pass that ignored this
 * would race in-flight uploads and delete files that are about to be valid.
 */
const ORPHAN_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Exponential backoff, capped so a permanently failing key still retries daily. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, 24 * 60 * 60 * 1000);
}

/** What the queue records when it does not delete an object another file still uses. */
const STILL_IN_USE = 'Another file still uses this object';

/**
 * The keys among `keys` that an attachment row still uses, as its file or its
 * thumbnail (#358): a fork's or an edit's copy of a file has a row of its own
 * for the same stored object, which must outlive the row it was copied from.
 */
export async function keysInUse(
  keys: string[],
  executor: Pick<typeof db, 'execute'> = db,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const list = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  );
  const rows = await executor.execute<{ key: string }>(sql`
    select storage_key as key from attachment where storage_key in (${list})
    union
    select thumbnail_key as key from attachment where thumbnail_key in (${list})
  `);
  return new Set(rows.map((row) => row.key));
}

/**
 * Settles the objects the delete trigger parked (`next_attempt_at` infinite,
 * migration 0045) because another row used them when a row was deleted. The
 * reaper of earlier releases takes only due entries, so it never touched them.
 * An object nothing uses any more is made due; one something still uses is
 * dropped from the queue, since whichever row is deleted last queues the
 * object itself (and two rows deleted at the same moment each park it, so the
 * second to commit finds it unused here).
 */
async function settleParkedObjects(): Promise<void> {
  await db.transaction(async (tx) => {
    const parked = await tx.execute<{ id: string; storage_key: string }>(sql`
      select id, storage_key from deleted_object
      where deleted_at is null and next_attempt_at = 'infinity'
      order by created_at
      limit ${BATCH_SIZE}
      for update skip locked
    `);
    if (parked.length === 0) return;
    const used = await keysInUse(
      parked.map((row) => row.storage_key),
      tx,
    );
    const ids = (rows: Array<{ id: string }>) =>
      sql.join(
        rows.map((row) => sql`${row.id}`),
        sql`, `,
      );
    const dropped = [...parked].filter((row) => used.has(row.storage_key));
    const due = [...parked].filter((row) => !used.has(row.storage_key));
    if (dropped.length > 0)
      await tx.execute(sql`
        update deleted_object set deleted_at = now(), last_error = ${STILL_IN_USE}
        where id in (${ids(dropped)})
      `);
    if (due.length > 0)
      await tx.execute(sql`
        update deleted_object set next_attempt_at = now() where id in (${ids(due)})
      `);
  });
}

/**
 * Deletes blobs queued by the attachment delete trigger.
 *
 * `skip locked` lets several replicas drain concurrently without contending,
 * and a failed delete stays queued with a growing backoff rather than becoming
 * a log line and a permanently orphaned file.
 *
 * An object is deleted only when no attachment row uses it any more (#358):
 * the trigger parks the object of a row deleted while another still uses it,
 * and this checks again just before deleting, whatever queued it.
 */
export async function drainDeletedObjects(now: Date = new Date()): Promise<number> {
  await settleParkedObjects();
  // `now` has millisecond precision and PostgreSQL microsecond: compare against
  // the end of that millisecond so a row queued within it is already due.
  const dueBefore = new Date(now.getTime() + 1);
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; storage_key: string; attempts: number }>(sql`
      select id, storage_key, attempts
      from deleted_object
      where deleted_at is null
        and next_attempt_at < ${dueBefore.toISOString()}::timestamptz
        and attempts < ${MAX_ATTEMPTS}
      order by next_attempt_at
      limit ${BATCH_SIZE}
      for update skip locked
    `);

    if (rows.length === 0) return [];

    // Push the next attempt out immediately so a crash mid-batch does not make
    // these rows spin on the next tick.
    await tx.execute(sql`
      update deleted_object
      set next_attempt_at = ${new Date(now.getTime() + 60_000).toISOString()}::timestamptz
      where id in (${sql.join(
        rows.map((row) => sql`${row.id}`),
        sql`, `,
      )})
    `);

    return rows;
  });

  if (claimed.length === 0) return 0;

  const driver = await getStorageDriver();
  const used = await keysInUse(claimed.map((row) => row.storage_key));
  let deleted = 0;

  for (const row of claimed) {
    if (used.has(row.storage_key)) {
      await db
        .update(schema.deletedObject)
        .set({ deletedAt: new Date(), lastError: STILL_IN_USE })
        .where(sql`${schema.deletedObject.id} = ${row.id}`);
      continue;
    }
    try {
      await driver.delete(row.storage_key);
      await db
        .update(schema.deletedObject)
        .set({ deletedAt: new Date(), lastError: null })
        .where(sql`${schema.deletedObject.id} = ${row.id}`);
      deleted += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = errorText(error);

      await db
        .update(schema.deletedObject)
        .set({
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        })
        .where(sql`${schema.deletedObject.id} = ${row.id}`);

      if (attempts >= MAX_ATTEMPTS) {
        logger.error(
          { storageKey: row.storage_key, attempts, error: message },
          'Giving up deleting a storage object; manual cleanup required',
        );
      }
    }
  }

  return deleted;
}

export interface ReconcileReport {
  orphanedObjects: number;
  missingObjects: number;
  queuedForDeletion: number;
}

/**
 * Compares storage against the database in both directions.
 *
 * Blobs with no attachment row are queued for deletion; rows whose blob is
 * gone are reported rather than repaired, because deleting the row would
 * silently destroy a conversation's attachment metadata over what may be a
 * transient storage fault.
 */
export async function reconcileStorage(options?: {
  deleteOrphans?: boolean;
  now?: Date;
}): Promise<ReconcileReport> {
  const now = options?.now ?? new Date();
  const cutoff = new Date(now.getTime() - ORPHAN_SAFETY_WINDOW_MS);
  const driver = await getStorageDriver();

  const report: ReconcileReport = {
    orphanedObjects: 0,
    missingObjects: 0,
    queuedForDeletion: 0,
  };

  let cursor: string | undefined;
  do {
    const page = await driver.list({ cursor, limit: 1_000 });
    cursor = page.cursor;

    // Health-check probes write and remove their own objects; a listing that
    // catches one mid-flight must not treat it as an orphan. Backups kept in
    // the attachment bucket have no attachment row by design, and neither
    // do compliance exports.
    const candidates = page.objects.filter(
      (object) =>
        object.lastModified < cutoff &&
        !object.key.startsWith('.oci-health-check/') &&
        !object.key.startsWith(BACKUP_STORAGE_PREFIX) &&
        !object.key.startsWith(COMPLIANCE_STORAGE_PREFIX),
    );
    if (candidates.length === 0) continue;

    const keys = candidates.map((object) => object.key);
    const known = await db
      .select({ storageKey: schema.attachment.storageKey })
      .from(schema.attachment)
      .where(inArray(schema.attachment.storageKey, keys));

    // Import uploads awaiting processing are referenced by their import row.
    const importUploads = await db
      .select({ storageKey: schema.conversationImport.storageKey })
      .from(schema.conversationImport)
      .where(inArray(schema.conversationImport.storageKey, keys));

    const knownKeys = new Set([
      ...known.map((row) => row.storageKey),
      ...importUploads.flatMap((row) => (row.storageKey ? [row.storageKey] : [])),
    ]);
    const orphans = candidates.filter((object) => !knownKeys.has(object.key));
    report.orphanedObjects += orphans.length;

    if (options?.deleteOrphans && orphans.length > 0) {
      // Route through the queue so deletion keeps its retry semantics.
      await db
        .insert(schema.deletedObject)
        .values(
          orphans.map((object) => ({
            storageKey: object.key,
            sizeBytes: object.sizeBytes,
          })),
        )
        .onConflictDoNothing();
      report.queuedForDeletion += orphans.length;
    }
  } while (cursor);

  // The other direction: rows whose blob has disappeared.
  const rows = await db
    .select({ id: schema.attachment.id, storageKey: schema.attachment.storageKey })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.uploadPending, false),
        sql`${schema.attachment.storageKey} <> 'pending'`,
      ),
    )
    .limit(5_000);

  for (const row of rows) {
    if (!(await driver.exists(row.storageKey))) {
      report.missingObjects += 1;
      logger.warn(
        { attachmentId: row.id, storageKey: row.storageKey },
        'Attachment row has no object in storage',
      );
    }
  }

  return report;
}

/** Removes drained queue rows so the table does not grow without bound. */
export async function pruneDrainedObjects(olderThan: Date): Promise<number> {
  const removed = await db
    .delete(schema.deletedObject)
    .where(
      and(
        sql`${schema.deletedObject.deletedAt} is not null`,
        lte(schema.deletedObject.deletedAt, olderThan),
      ),
    )
    .returning({ id: schema.deletedObject.id });

  return removed.length;
}

/** Queue depth for the admin storage view. */
export async function pendingDeletionCount(): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.deletedObject)
    .where(isNull(schema.deletedObject.deletedAt));

  return Number(row?.value ?? 0);
}
