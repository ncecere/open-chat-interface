import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, desc, eq, inArray, isNull, ne, schema, sql } from '@oci/db';
import type { ConversationImportSummary, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getStorageDriver, type StorageDriver } from '../storage/index.js';
import { assertStorageAllowanceForUsage, getStorageLimits } from '../storage/quota.js';
import { admissionTotals, lockStorageUsage, type StorageTransaction } from '../storage/usage.js';
import {
  detectConversationSource,
  type ImportedConversation,
  type ImportedSource,
  mapChatGptConversation,
  mapClaudeConversation,
} from './import-mappers.js';
import {
  DEFAULT_READER_LIMITS,
  ImportRejected,
  type ReaderLimits,
  readExport,
} from './import-reader.js';

type ImportRow = typeof schema.conversationImport.$inferSelect;

/** A running import that has not reported progress for this long is presumed dead. */
const IMPORT_STALE_MS = 10 * 60 * 1000;
/** Claims before a repeatedly crashing import is given up on. */
const IMPORT_MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 15_000;
const MESSAGE_BATCH = 500;

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

/**
 * Claims the oldest runnable import.
 *
 * `skip locked` lets replicas claim concurrently; a running row whose heartbeat
 * has gone stale was abandoned by a crash or restart and is claimed again,
 * which is safe because applying an import is idempotent. A person's second
 * import never starts while their first is genuinely running.
 */
async function claimNextImport(now = new Date()): Promise<ImportRow | null> {
  const staleBefore = new Date(now.getTime() - IMPORT_STALE_MS).toISOString();
  const [row] = await db
    .update(schema.conversationImport)
    .set({
      status: 'running',
      attempts: sql`${schema.conversationImport.attempts} + 1`,
      startedAt: sql`coalesce(${schema.conversationImport.startedAt}, now())`,
      updatedAt: now,
    })
    .where(
      eq(
        schema.conversationImport.id,
        sql`(
          select candidate.id from conversation_import candidate
          where (
            candidate.status = 'pending'
            or (candidate.status = 'running' and candidate.updated_at < ${staleBefore}::timestamptz)
          )
          and not exists (
            select 1 from conversation_import other
            where other.user_id = candidate.user_id
              and other.id <> candidate.id
              and other.status = 'running'
              and other.updated_at >= ${staleBefore}::timestamptz
          )
          order by candidate.created_at, candidate.id
          limit 1
          for update skip locked
        )`,
      ),
    )
    .returning();
  return row ?? null;
}

interface Progress {
  imported: number;
  skipped: number;
  failed: number;
  unknown: Record<string, number>;
  sources: Record<ImportedSource, number>;
  claudeBlocks: boolean;
}

/**
 * Writes one conversation and its messages in a single transaction.
 *
 * The partial unique index on (user, source, source id) makes this idempotent:
 * a conversation imported before, or still in the trash, is skipped rather
 * than duplicated or overwritten, so messages added here since are never lost.
 */
async function insertImportedConversation(
  owner: { userId: string; organizationId: string },
  conversation: ImportedConversation,
): Promise<'imported' | 'skipped'> {
  const createdAt = conversation.createdAt ?? new Date();
  const lastMessageAt = conversation.messages.at(-1)?.createdAt ?? conversation.updatedAt;
  const updatedAt = conversation.updatedAt ?? lastMessageAt ?? createdAt;

  return db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(schema.thread)
      .values({
        organizationId: owner.organizationId,
        userId: owner.userId,
        title: conversation.title,
        importSource: conversation.source,
        importSourceId: conversation.sourceId,
        lastMessageAt: lastMessageAt ?? updatedAt,
        createdAt,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.thread.id });
    if (!thread) return 'skipped';

    let promptId: string | null = null;
    const rows = conversation.messages.map((message, position) => {
      const id = randomUUID();
      const parentMessageId = message.role === 'assistant' ? promptId : null;
      if (message.role === 'user') promptId = id;
      const at = message.createdAt ?? createdAt;
      return {
        id,
        threadId: thread.id,
        userId: owner.userId,
        role: message.role,
        parts: message.parts,
        position,
        parentMessageId,
        modelSlug: message.modelSlug,
        // Imported turns are history, not generations: no usage, always complete.
        status: 'complete' as const,
        createdAt: at,
        updatedAt: at,
      };
    });
    for (let index = 0; index < rows.length; index += MESSAGE_BATCH) {
      await tx.insert(schema.message).values(rows.slice(index, index + MESSAGE_BATCH));
    }
    return 'imported';
  });
}

async function applyConversation(row: ImportRow, value: unknown, progress: Progress) {
  const source = detectConversationSource(value);
  if (!source) {
    progress.failed += 1;
    progress.unknown['unrecognised-conversation'] =
      (progress.unknown['unrecognised-conversation'] ?? 0) + 1;
    return;
  }
  progress.sources[source] += 1;
  const mapped =
    source === 'chatgpt' ? mapChatGptConversation(value) : mapClaudeConversation(value);
  if (mapped.usedContentBlocks) progress.claudeBlocks = true;
  for (const type of mapped.unknownTypes) {
    progress.unknown[type] = (progress.unknown[type] ?? 0) + 1;
  }
  if (!mapped.conversation) {
    if (mapped.reason === 'empty') progress.skipped += 1;
    else progress.failed += 1;
    return;
  }
  try {
    const outcome = await insertImportedConversation(
      { userId: row.userId, organizationId: row.organizationId },
      mapped.conversation,
    );
    if (outcome === 'imported') progress.imported += 1;
    else progress.skipped += 1;
  } catch (error) {
    progress.failed += 1;
    logger.warn(
      { error, importId: row.id, sourceId: mapped.conversation.sourceId },
      'Failed to import one conversation',
    );
  }
}

function detectedSource(progress: Progress): 'chatgpt' | 'claude' | 'unknown' {
  if (progress.sources.chatgpt === 0 && progress.sources.claude === 0) return 'unknown';
  return progress.sources.chatgpt >= progress.sources.claude ? 'chatgpt' : 'claude';
}

/** ChatGPT's 2026 layout splits files and adds a manifest; Claude's adds content blocks. */
function formatVersion(
  source: 'chatgpt' | 'claude' | 'unknown',
  entries: string[],
  claudeBlocks: boolean,
): string | null {
  const names = entries.map((entry) => entry.toLowerCase());
  if (source === 'chatgpt') {
    return names.some(
      (name) =>
        /conversations-\d+\.json$/.test(name) ||
        name.endsWith('export_manifest.json') ||
        name.endsWith('conversation_asset_file_names.json'),
    )
      ? 'v2'
      : 'v1';
  }
  if (source === 'claude') {
    return claudeBlocks ||
      names.some(
        (name) => name.includes('design_chats/') || /(^|\/)projects\/[^/]+\.json$/.test(name),
      )
      ? 'v2'
      : 'v1';
  }
  return null;
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
        if (handled % 25 === 0 || Date.now() - lastBeat > HEARTBEAT_MS) await heartbeat();
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
    const row = await claimNextImport(options?.now);
    if (!row) break;
    await processImport(row, options?.limits);
    processed += 1;
  }
  return processed;
}

/** Starts processing now rather than at the next job tick. Fire and forget. */
export function scheduleImportProcessing(): void {
  void import('../jobs/index.js')
    .then(({ runJobNow }) => runJobNow('imports.process'))
    .catch((error: unknown) => {
      logger.warn({ error }, 'Could not start import processing immediately');
    });
}
