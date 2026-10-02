import { and, eq, inArray, isNull, lte, schema, sql } from '@oci/db';
import { BACKUP_STORAGE_PREFIX } from '@oci/shared';
import { db } from '../../db/index.js';
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

/**
 * Deletes blobs queued by the attachment delete trigger.
 *
 * `skip locked` lets several replicas drain concurrently without contending,
 * and a failed delete stays queued with a growing backoff rather than becoming
 * a log line and a permanently orphaned file.
 */
export async function drainDeletedObjects(now: Date = new Date()): Promise<number> {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; storage_key: string; attempts: number }>(sql`
      select id, storage_key, attempts
      from deleted_object
      where deleted_at is null
        and next_attempt_at <= ${now.toISOString()}::timestamptz
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
  let deleted = 0;

  for (const row of claimed) {
    try {
      await driver.delete(row.storage_key);
      await db
        .update(schema.deletedObject)
        .set({ deletedAt: new Date(), lastError: null })
        .where(sql`${schema.deletedObject.id} = ${row.id}`);
      deleted += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);

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
    // the attachment bucket have no attachment row by design.
    const candidates = page.objects.filter(
      (object) =>
        object.lastModified < cutoff &&
        !object.key.startsWith('.oci-health-check/') &&
        !object.key.startsWith(BACKUP_STORAGE_PREFIX),
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
