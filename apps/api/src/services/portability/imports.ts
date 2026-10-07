import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, desc, eq, inArray, isNull, ne, schema, sql } from '@oci/db';
import type { ConversationImportSummary, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { isConnectionError, retryOnConnectionError } from '../../lib/db-connection.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { kickJob } from '../jobs/requests.js';
import { jobMayContinue } from '../jobs/runner.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getStorageDriver, type StorageDriver } from '../storage/index.js';
import { assertStorageAllowanceForUsage, getStorageLimits } from '../storage/quota.js';
import { admissionTotals, lockStorageUsage, type StorageTransaction } from '../storage/usage.js';
import { applyConversation, detectedSource, formatVersion, type Progress } from './import-apply.js';
import { claimNextImport, type ImportRow } from './import-queue.js';
import {
  DEFAULT_READER_LIMITS,
  ImportRejected,
  type ReaderLimits,
  readExport,
} from './import-reader.js';

/** Claims before a repeatedly crashing import is given up on. */
const IMPORT_MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 15_000;

export function serializeImport(row: ImportRow): ConversationImportSummary {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    filename: row.filename,
    sizeBytes: Number(row.sizeBytes),
    importedCount: row.importedCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    error: row.error,
    formatVersion: row.details?.formatVersion ?? null,
    warnings: row.details?.warnings ?? [],
    unknownContentTypes: row.details?.unknownContentTypes ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function listImports(userId: string): Promise<ImportRow[]> {
  return db
    .select()
    .from(schema.conversationImport)
    .where(eq(schema.conversationImport.userId, userId))
    .orderBy(desc(schema.conversationImport.createdAt))
    .limit(50);
}

const activeStatuses = ['pending', 'running'] as const;

/** One import at a time per person: a second would only contend for the same rows. */
export async function assertNoActiveImport(
  userId: string,
  tx: StorageTransaction | typeof db = db,
) {
  const [active] = await tx
    .select({ id: schema.conversationImport.id })
    .from(schema.conversationImport)
    .where(
      and(
        eq(schema.conversationImport.userId, userId),
        inArray(schema.conversationImport.status, [...activeStatuses]),
      ),
    )
    .limit(1);
  if (active) {
    throw conflict(
      'An import is already in progress. Wait for it to finish before starting another.',
    );
  }
}

async function storeFile(driver: StorageDriver, key: string, path: string): Promise<void> {
  if (driver.putFile) {
    await driver.putFile(key, path, 'application/octet-stream');
    return;
  }
  await driver.put(key, await readFile(path), 'application/octet-stream');
}

async function openStored(driver: StorageDriver, key: string): Promise<AsyncIterable<Uint8Array>> {
  if (driver.getStream) return (await driver.getStream(key)) as AsyncIterable<Uint8Array>;
  const bytes = await driver.get(key);
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    })(),
  );
}

/** Deletes a released upload now; the queue row written alongside retries on failure. */
async function deleteStoredNow(key: string): Promise<void> {
  try {
    const driver = await getStorageDriver();
    await driver.delete(key);
    await db
      .update(schema.deletedObject)
      .set({ deletedAt: new Date(), lastError: null })
      .where(and(eq(schema.deletedObject.storageKey, key), isNull(schema.deletedObject.deletedAt)));
  } catch (error) {
    logger.warn({ error, storageKey: key }, 'Import upload deletion deferred to the cleanup job');
  }
}

/**
 * Stores an uploaded export and queues it.
 *
 * The blob is written first and the row committed second, so a pending row
 * always has its file. A crash between the two leaves an unreferenced blob,
 * which storage reconciliation already treats as an orphan. The upload counts
 * against the person's storage allowance until processing releases it.
 */
export async function createImport(params: {
  userId: string;
  role: UserRole;
  organizationId: string;
  filename: string;
  path: string;
  sizeBytes: number;
}): Promise<ImportRow> {
  const id = randomUUID();
  const storageKey = `imports/${params.userId}/${id}`;
  const organizationId = params.organizationId || (await getDefaultOrganizationId());
  const limits = await getStorageLimits(params.role);
  const driver = await getStorageDriver();
  await storeFile(driver, storageKey, params.path);

  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, params.userId))
        .for('key share');
      if (!owner) throw notFound('Account no longer exists');
      // The storage-usage row is the per-person admission mutex for uploads.
      await lockStorageUsage(tx, { organizationId, userId: params.userId });
      await assertNoActiveImport(params.userId, tx);
      const totals = await admissionTotals(tx, params.userId);
      assertStorageAllowanceForUsage(
        { ...totals, ...limits },
        // An export is one transient file, not an attachment: only total bytes apply.
        { incomingBytes: params.sizeBytes, incomingFiles: 0, checkFileSize: false },
      );
      const [row] = await tx
        .insert(schema.conversationImport)
        .values({
          id,
          organizationId,
          userId: params.userId,
          filename: params.filename.slice(0, 255) || 'export',
          sizeBytes: params.sizeBytes,
          storageKey,
        })
        .returning();
      if (!row) throw new Error('Failed to record import');
      return row;
    });
  } catch (error) {
    await driver.delete(storageKey).catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError, storageKey }, 'Failed to remove a rejected import upload');
    });
    throw error;
  }
}

/** Removes a finished or not-yet-started import; the delete trigger queues its upload. */
export async function deleteImport(id: string, userId: string): Promise<void> {
  const [removed] = await db
    .delete(schema.conversationImport)
    .where(
      and(
        eq(schema.conversationImport.id, id),
        eq(schema.conversationImport.userId, userId),
        ne(schema.conversationImport.status, 'running'),
      ),
    )
    .returning({ storageKey: schema.conversationImport.storageKey });

  if (!removed) {
    const [existing] = await db
      .select({ id: schema.conversationImport.id })
      .from(schema.conversationImport)
      .where(
        and(eq(schema.conversationImport.id, id), eq(schema.conversationImport.userId, userId)),
      )
      .limit(1);
    if (existing) throw conflict('This import is running. It can be removed once it finishes.');
    throw notFound('Import not found');
  }
  if (removed.storageKey) await deleteStoredNow(removed.storageKey);
}

/** Ends an import, releasing its upload in the same transaction that records the outcome. */
async function finishImport(
  row: ImportRow,
  outcome: {
    status: 'completed' | 'failed';
    error: string | null;
    progress: Progress;
    details: ImportRow['details'];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (row.storageKey) {
      await tx.insert(schema.deletedObject).values({
        storageKey: row.storageKey,
        sizeBytes: Number(row.sizeBytes),
        userId: row.userId,
      });
    }
    await tx
      .update(schema.conversationImport)
      .set({
        status: outcome.status,
        error: outcome.error,
        source: detectedSource(outcome.progress),
        importedCount: outcome.progress.imported,
        skippedCount: outcome.progress.skipped,
        failedCount: outcome.progress.failed,
        details: outcome.details,
        storageKey: null,
        finishedAt: new Date(),
      })
      .where(eq(schema.conversationImport.id, row.id));
  });
  if (row.storageKey) await deleteStoredNow(row.storageKey);

  await recordAudit({
    actorUserId: row.userId,
    action: 'user.import',
    targetType: 'conversation_import',
    targetId: row.id,
    metadata: {
      stage: outcome.status,
      source: detectedSource(outcome.progress),
      imported: outcome.progress.imported,
      skipped: outcome.progress.skipped,
      failed: outcome.progress.failed,
    },
  });
}

/** Processes one claimed import from its stored upload. Never throws. */
/**
 * Thrown at a checkpoint when the job must stop (its lock was lost with its
 * connection, or this replica is shutting down): the import is requeued and
 * resumed from where the stored conversations end.
 */
class ImportPaused extends Error {}

async function processImport(
  row: ImportRow,
  limits: ReaderLimits = DEFAULT_READER_LIMITS,
): Promise<void> {
  const progress: Progress = {
    imported: 0,
    skipped: 0,
    failed: 0,
    unknown: {},
    sources: { chatgpt: 0, claude: 0 },
    claudeBlocks: false,
  };

  if (row.attempts > IMPORT_MAX_ATTEMPTS) {
    await finishImport(row, {
      status: 'failed',
      error: 'The import stopped unexpectedly several times. Try uploading the file again.',
      progress,
      details: row.details,
    });
    return;
  }

  let lastBeat = Date.now();
  const heartbeat = async () => {
    lastBeat = Date.now();
    const [alive] = await db
      .update(schema.conversationImport)
      .set({
        importedCount: progress.imported,
        skippedCount: progress.skipped,
        failedCount: progress.failed,
        source: detectedSource(progress),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.conversationImport.id, row.id),
          eq(schema.conversationImport.status, 'running'),
        ),
      )
      .returning({ id: schema.conversationImport.id });
    if (!alive) throw new Error('Import record disappeared while running');
  };

  try {
    if (!row.storageKey) throw new ImportRejected('The uploaded file is no longer available.');
    const driver = await getStorageDriver();
    const stream = await openStored(driver, row.storageKey);
    const report = await readExport(
      stream,
      async (value) => {
        await applyConversation(row, value, progress);
        const handled = progress.imported + progress.skipped + progress.failed;
        if (handled % 25 === 0 || Date.now() - lastBeat > HEARTBEAT_MS) {
          // The check between batches (v0.11): a long import is many batches.
          if (!(await jobMayContinue())) throw new ImportPaused();
          await heartbeat();
        }
      },
      limits,
    );

    const source = detectedSource(progress);
    const warnings: string[] = [];
    if (report.missingFiles.length > 0) {
      warnings.push(
        `The export looks incomplete: ${report.missingFiles.length} conversation file(s) listed in its manifest were missing.`,
      );
    }
    const unknownTotal = Object.values(progress.unknown).reduce((sum, count) => sum + count, 0);
    if (unknownTotal > 0) {
      warnings.push(`${unknownTotal} item(s) of unrecognised content were left out.`);
      logger.info(
        { importId: row.id, unknownContentTypes: progress.unknown },
        'Import encountered unrecognised content types',
      );
    }
    const handled = progress.imported + progress.skipped + progress.failed;
    await finishImport(row, {
      status: handled === 0 || source === 'unknown' ? 'failed' : 'completed',
      error:
        handled === 0 || source === 'unknown'
          ? 'No ChatGPT or Claude conversations were found in this file.'
          : null,
      progress,
      details: {
        formatVersion: formatVersion(source, report.entries, progress.claudeBlocks) ?? undefined,
        unknownContentTypes: progress.unknown,
        warnings,
      },
    });
  } catch (error) {
    if (isConnectionError(error) || error instanceof ImportPaused) {
      // A database failover or a stop (v0.11): put it back in the queue. The next run
      // starts it again from the file, and the conversations already stored
      // are recognised (thread_import_source_unique) and skipped. A failover
      // does not use up one of its attempts. Saving that waits out the
      // failover (bounded); if even that fails, the row's lease runs out
      // (IMPORT_STALE_MS) and it is resumed then.
      logger.warn(
        { importId: row.id, paused: error instanceof ImportPaused },
        'Import interrupted (lost database connection, lost job lock or shutdown); requeued',
      );
      await retryOnConnectionError(() =>
        db
          .update(schema.conversationImport)
          .set({
            status: 'pending',
            attempts: sql`greatest(${schema.conversationImport.attempts} - 1, 0)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.conversationImport.id, row.id),
              eq(schema.conversationImport.status, 'running'),
            ),
          ),
      ).catch(() => undefined);
      return;
    }
    const rejected = error instanceof ImportRejected;
    if (!rejected) logger.error({ error, importId: row.id }, 'Import failed');
    await finishImport(row, {
      status: 'failed',
      error: rejected ? error.message : 'The import could not be processed.',
      progress,
      details: { unknownContentTypes: progress.unknown },
    }).catch((finishError: unknown) => {
      logger.error({ error: finishError, importId: row.id }, 'Failed to record import failure');
    });
  }
}

/**
 * Drains runnable imports, one at a time, until none remain or the batch is
 * spent. Run by the background job runner and kicked straight after an upload.
 */
export async function processPendingImports(options?: {
  limits?: ReaderLimits;
  maxImports?: number;
  now?: Date;
}): Promise<number> {
  let processed = 0;
  const maxImports = options?.maxImports ?? 10;
  while (processed < maxImports) {
    // A failover may have taken the job's lock, or this replica is stopping.
    if (processed > 0 && !(await jobMayContinue())) break;
    const row = await claimNextImport(options?.now);
    if (!row) break;
    await processImport(row, options?.limits);
    processed += 1;
  }
  return processed;
}

/**
 * Starts processing now rather than at the next job tick, here or (on a
 * `web` replica) on a worker. Fire and forget.
 */
export function scheduleImportProcessing(): void {
  kickJob('imports.process', () =>
    import('../jobs/index.js')
      .then(({ runJobNow }) => runJobNow('imports.process'))
      .catch((error: unknown) => {
        logger.warn({ error }, 'Could not start import processing immediately');
      }),
  );
}
