import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or, schema, sql } from '@oci/db';
import { BACKUP_STORAGE_PREFIX, type BackupRun, type BackupStatus } from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { recordAudit } from '../audit.js';
import { runExclusively } from '../jobs/runner.js';
import { backupDuration, backupRuns } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';
import type { StorageDriver } from '../storage/driver.js';
import { getStorageDriver } from '../storage/index.js';
import {
  captureTail,
  exitCode,
  pgConnectionFromUrl,
  pgDumpVersion,
  pgToolPath,
  scrubSecret,
} from './pg-tools.js';
import { selectBackupsToKeep } from './retention.js';
import {
  type BackupTarget,
  backupConfigurationIssues,
  backupSettings,
  type ResolvedBackupSettings,
  resolveBackupTarget,
  toPublicBackupSettings,
} from './settings.js';

/**
 * Automated backups: a `pg_dump` archive (custom format) and a manifest of
 * attachment objects, written to S3-compatible storage by the job runner,
 * then read back and verified. See docs/admin/backups.md.
 *
 * Nothing is held in memory whole: the dump streams from `pg_dump` into a
 * multipart upload, the manifest is produced a page of attachments at a time,
 * and verification streams the stored archive back through `pg_restore`.
 */

export const BACKUP_JOB = 'backups.run';

type RunRow = typeof schema.backupRun.$inferSelect;
type Actor = { id: string; email: string } | null;

const sha256 = () => createHash('sha256');

/** Where a step failed, kept short and free of secrets for the run history. */
class BackupError extends Error {}

/** Wraps a source so its bytes are counted and hashed as they pass. */
async function* measured(
  source: AsyncIterable<Uint8Array>,
  totals: { bytes: number; hash: ReturnType<typeof sha256> },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    totals.bytes += chunk.byteLength;
    totals.hash.update(chunk);
    yield chunk;
  }
}

/**
 * Streams `pg_dump --format=custom` into the target. The upload completes only
 * if pg_dump exits successfully: a failed dump throws from the source, which
 * aborts the multipart upload instead of storing a truncated archive.
 */
async function dumpDatabase(
  target: BackupTarget,
  key: string,
  databaseUrl: string,
): Promise<{ bytes: number; sha256: string }> {
  const connection = await pgConnectionFromUrl(databaseUrl);
  const totals = { bytes: 0, hash: sha256() };
  try {
    const child = spawn(pgToolPath('pg_dump'), ['--format=custom', '--no-password'], {
      env: connection.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = captureTail(child);
    const exited = exitCode(child);
    exited.catch(() => undefined);

    async function* output(): AsyncGenerator<Uint8Array> {
      if (child.stdout) yield* child.stdout as AsyncIterable<Uint8Array>;
      let code: number;
      try {
        code = await exited;
      } catch (error) {
        throw new BackupError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'pg_dump was not found. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.'
            : 'pg_dump could not be started.',
        );
      }
      if (code !== 0)
        throw new BackupError(
          `pg_dump failed (exit ${code}): ${scrubSecret(stderr(), connection.password).slice(-500) || 'no output'}`,
        );
    }

    try {
      await target.driver.putStream(key, measured(output(), totals), 'application/octet-stream');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    return { bytes: totals.bytes, sha256: totals.hash.digest('hex') };
  } finally {
    await connection.cleanup();
  }
}

async function readObject(driver: StorageDriver, key: string): Promise<AsyncIterable<Uint8Array>> {
  if (driver.getStream) return (await driver.getStream(key)) as AsyncIterable<Uint8Array>;
  return Readable.from([await driver.get(key)]);
}

/** SHA-256 and size of one stored attachment object. */
async function checksumObject(driver: StorageDriver, key: string) {
  const hash = sha256();
  let bytes = 0;
  for await (const chunk of await readObject(driver, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

interface ManifestTotals {
  count: number;
  bytes: number;
  missing: number;
}

const PAGE = 200;

/**
 * One JSON line per attachment object (file and thumbnail): key, size and
 * SHA-256. Checksums are cached per key, since attachment objects are never
 * rewritten, so each run reads only objects it has not seen before.
 * No file names or other content are written.
 */
async function* attachmentManifest(totals: ManifestTotals): AsyncGenerator<Uint8Array> {
  const source = await getStorageDriver();
  let after = '';
  for (;;) {
    const rows = await db
      .select({
        id: schema.attachment.id,
        storageKey: schema.attachment.storageKey,
        thumbnailKey: schema.attachment.thumbnailKey,
      })
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.uploadPending, false),
          ne(schema.attachment.storageKey, 'pending'),
          gt(schema.attachment.id, after),
        ),
      )
      .orderBy(asc(schema.attachment.id))
      .limit(PAGE);
    if (rows.length === 0) return;
    after = rows.at(-1)!.id;

    const objects = rows.flatMap((row) => [
      { attachmentId: row.id, key: row.storageKey, kind: 'file' as const },
      ...(row.thumbnailKey
        ? [{ attachmentId: row.id, key: row.thumbnailKey, kind: 'thumbnail' as const }]
        : []),
    ]);
    const cached = new Map(
      (
        await db
          .select()
          .from(schema.backupObjectChecksum)
          .where(
            inArray(
              schema.backupObjectChecksum.storageKey,
              objects.map((object) => object.key),
            ),
          )
      ).map((row) => [row.storageKey, row]),
    );

    const lines: string[] = [];
    for (const object of objects) {
      let entry = cached.get(object.key);
      if (!entry) {
        try {
          const measured = await checksumObject(source, object.key);
          entry = {
            storageKey: object.key,
            sizeBytes: measured.bytes,
            sha256: measured.sha256,
            computedAt: new Date(),
          };
          await db.insert(schema.backupObjectChecksum).values(entry).onConflictDoNothing();
        } catch {
          totals.missing += 1;
          lines.push(`${JSON.stringify({ ...object, missing: true })}\n`);
          continue;
        }
      }
      totals.count += 1;
      totals.bytes += entry.sizeBytes;
      lines.push(
        `${JSON.stringify({ ...object, bytes: entry.sizeBytes, sha256: entry.sha256 })}\n`,
      );
    }
    yield Buffer.from(lines.join(''), 'utf8');
  }
}

/**
 * Reads the stored archive back: its size and SHA-256 must match what was
 * written, and `pg_restore --list` must read its table of contents.
 */
async function verifyDump(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string },
): Promise<string> {
  const child = spawn(pgToolPath('pg_restore'), ['--list'], {
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = captureTail(child);
  const exited = exitCode(child);
  exited.catch(() => undefined);
  let listing = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (listing.length < 20 * 1024 * 1024) listing += chunk;
  });
  // pg_restore stops reading once it has the table of contents; the rest is
  // still read here for the checksum, and writes to the closed pipe are dropped.
  let stdinOpen = true;
  child.stdin?.on('error', () => {
    stdinOpen = false;
  });
  child.stdin?.on('close', () => {
    stdinOpen = false;
  });

  const hash = sha256();
  let bytes = 0;
  try {
    for await (const chunk of await readObject(target.driver, key)) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (stdinOpen && child.stdin && !child.stdin.write(chunk) && stdinOpen) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          child.stdin?.once('drain', done);
          child.stdin?.once('close', done);
          child.stdin?.once('error', done);
        });
      }
    }
  } finally {
    child.stdin?.end();
  }

  let code: number;
  try {
    code = await exited;
  } catch {
    throw new BackupError(
      'pg_restore was not found. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.',
    );
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw new BackupError(
      'Verification failed: the stored archive does not match what was written.',
    );
  if (code !== 0)
    throw new BackupError(
      `Verification failed: pg_restore could not read the archive (${stderr().slice(-300) || `exit ${code}`}).`,
    );

  const entries = listing.split('\n').filter((line) => line.trim() && !line.startsWith(';'));
  const tables = entries.filter((line) => / TABLE (?!DATA)/.test(line)).length;
  if (entries.length === 0 || tables === 0)
    throw new BackupError('Verification failed: the archive lists no tables.');
  return `${entries.length} archive entries, ${tables} tables`;
}

/** Reads the manifest back and checks its checksum and line count. */
async function verifyManifest(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string; lines: number },
): Promise<void> {
  const hash = sha256();
  let bytes = 0;
  let lines = 0;
  for await (const chunk of await readObject(target.driver, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 0x0a) lines += 1;
  }
  if (
    bytes !== expected.bytes ||
    hash.digest('hex') !== expected.sha256 ||
    lines !== expected.lines
  )
    throw new BackupError('Verification failed: the stored attachment manifest does not match.');
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

/** Finishes runs left `running` by a process that died; called while holding the backup lock. */
async function closeInterruptedRuns(): Promise<void> {
  await db
    .update(schema.backupRun)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorMessage: 'Interrupted before finishing.',
    })
    .where(eq(schema.backupRun.status, 'running'));
}

/**
 * Runs one backup now: dump, manifest, verification, then retention. Records
 * the run, its metrics and a `backup.run` audit entry, and rethrows a failure
 * so the job run is marked failed too. Callers hold the backup job lock.
 */
export async function performBackup(options: {
  trigger: 'schedule' | 'manual';
  actor?: Actor;
  databaseUrl?: string;
}): Promise<RunRow> {
  const settings = await backupSettings();
  await closeInterruptedRuns();
  const startedAt = new Date();
  const [run] = await db
    .insert(schema.backupRun)
    .values({
      organizationId: await getDefaultOrganizationId(),
      trigger: options.trigger,
      startedAt,
      destination: settings.destination,
      keyPrefix: settings.destination === 'storage' ? BACKUP_STORAGE_PREFIX : settings.prefix,
    })
    .returning();
  const written: string[] = [];

  try {
    return await withSpan('backup.run', { 'oci.backup.trigger': options.trigger }, async () => {
      const target = await resolveBackupTarget(settings);
      const folder = `${target.root}${stamp(startedAt)}-${run!.id.slice(0, 8)}/`;
      const dumpKey = `${folder}database.dump`;
      const attachmentsKey = `${folder}attachments.jsonl`;
      const manifestKey = `${folder}manifest.json`;

      written.push(dumpKey);
      const dump = await dumpDatabase(
        target,
        dumpKey,
        options.databaseUrl ?? loadEnv().DATABASE_URL,
      );

      const totals: ManifestTotals = { count: 0, bytes: 0, missing: 0 };
      const manifestFile = { bytes: 0, hash: sha256() };
      written.push(attachmentsKey);
      await target.driver.putStream(
        attachmentsKey,
        measured(attachmentManifest(totals), manifestFile),
        'application/x-ndjson',
      );
      const attachments = { bytes: manifestFile.bytes, sha256: manifestFile.hash.digest('hex') };

      const migration = await latestMigration();
      written.push(manifestKey);
      await target.driver.put(
        manifestKey,
        Buffer.from(
          JSON.stringify(
            {
              format: 'oci-backup/1',
              ociVersion: APP_VERSION,
              migration,
              createdAt: startedAt.toISOString(),
              database: { key: dumpKey, format: 'pg_dump custom', ...dump },
              attachments: {
                key: attachmentsKey,
                storage: (await getSetting('storage')).driver,
                objects: totals.count,
                objectBytes: totals.bytes,
                missingObjects: totals.missing,
                ...attachments,
              },
            },
            null,
            2,
          ),
        ),
        'application/json',
      );

      const detail = await verifyDump(target, dumpKey, dump);
      await verifyManifest(target, attachmentsKey, {
        ...attachments,
        lines: totals.count + totals.missing,
      });

      const [finished] = await db
        .update(schema.backupRun)
        .set({
          status: 'succeeded',
          finishedAt: new Date(),
          dumpKey,
          dumpBytes: dump.bytes,
          dumpSha256: dump.sha256,
          manifestKey,
          attachmentsKey,
          attachmentCount: totals.count,
          attachmentBytes: totals.bytes,
          missingObjects: totals.missing,
          verified: true,
          verificationDetail: `${detail}; ${totals.count} attachment objects checksummed${
            totals.missing ? `, ${totals.missing} missing` : ''
          }`,
        })
        .where(eq(schema.backupRun.id, run!.id))
        .returning();

      const durationMs = Date.now() - startedAt.getTime();
      backupRuns.inc({ outcome: 'succeeded' });
      backupDuration.observe({}, durationMs / 1000);
      logger.info(
        { backupRunId: run!.id, dumpBytes: dump.bytes, attachments: totals.count, durationMs },
        'Backup completed',
      );
      await recordAudit({
        actorUserId: options.actor?.id ?? null,
        actorEmail: options.actor?.email ?? null,
        action: 'backup.run',
        targetType: 'backup',
        targetId: run!.id,
        metadata: {
          trigger: options.trigger,
          status: 'succeeded',
          dumpBytes: dump.bytes,
          attachmentObjects: totals.count,
          missingObjects: totals.missing,
          verified: true,
        },
      });

      await pruneBackups(settings, target).catch((error: unknown) =>
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'Backup retention failed',
        ),
      );
      return finished!;
    });
  } catch (error) {
    const message =
      error instanceof BackupError
        ? error.message
        : `Backup failed: ${error instanceof Error ? error.message : String(error)}`;
    const safe = scrubSecret(message, passwordOf(options.databaseUrl)).slice(0, 1_000);
    await cleanupObjects(settings, written);
    await db
      .update(schema.backupRun)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: safe,
        ...(written.length ? { prunedAt: new Date() } : {}),
      })
      .where(eq(schema.backupRun.id, run!.id));
    backupRuns.inc({ outcome: 'failed' });
    logger.error({ backupRunId: run!.id, error: safe }, 'Backup failed');
    await recordAudit({
      actorUserId: options.actor?.id ?? null,
      actorEmail: options.actor?.email ?? null,
      action: 'backup.run',
      targetType: 'backup',
      targetId: run!.id,
      metadata: { trigger: options.trigger, status: 'failed', error: safe.slice(0, 300) },
    });
    throw new Error(safe);
  }
}

function passwordOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? loadEnv().DATABASE_URL);
    return parsed.password ? decodeURIComponent(parsed.password) : null;
  } catch {
    return null;
  }
}

/** Removes what a failed run managed to write; best effort. */
async function cleanupObjects(settings: ResolvedBackupSettings, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  let target: BackupTarget;
  try {
    target = await resolveBackupTarget(settings);
  } catch {
    return;
  }
  for (const key of keys) await target.driver.delete(key).catch(() => undefined);
}

/** Drizzle's newest applied migration (its journal `when`), which identifies the schema. */
async function latestMigration(): Promise<string | null> {
  try {
    const rows = await db.execute<{ created_at: string }>(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    return rows[0]?.created_at ? String(rows[0].created_at) : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the objects of successful backups that retention no longer keeps.
 * Only runs written to the current destination are considered; backups made
 * before a destination change are left for the administrator.
 */
export async function pruneBackups(
  settings: ResolvedBackupSettings,
  target?: BackupTarget,
): Promise<number> {
  const resolved = target ?? (await resolveBackupTarget(settings));
  const runs = await db
    .select()
    .from(schema.backupRun)
    .where(
      and(
        eq(schema.backupRun.status, 'succeeded'),
        isNull(schema.backupRun.prunedAt),
        eq(schema.backupRun.destination, settings.destination),
        eq(schema.backupRun.keyPrefix, resolved.root),
      ),
    );
  const keep = selectBackupsToKeep(runs, settings.keepDaily, settings.keepWeekly);
  let pruned = 0;
  for (const run of runs) {
    if (keep.has(run.id)) continue;
    try {
      for (const key of [run.dumpKey, run.attachmentsKey, run.manifestKey])
        if (key) await resolved.driver.delete(key);
    } catch (error) {
      logger.warn(
        { backupRunId: run.id, err: error instanceof Error ? error.message : String(error) },
        'Could not delete an expired backup; will retry next run',
      );
      continue;
    }
    await db
      .update(schema.backupRun)
      .set({ prunedAt: new Date() })
      .where(eq(schema.backupRun.id, run.id));
    pruned += 1;
  }
  return pruned;
}

/** The most recent scheduled start at or before `now`. */
export function scheduledSlot(now: Date, hourUtc: number): Date {
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0),
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

/** Whether today's slot is already covered: any scheduled attempt, or a successful manual backup. */
async function slotCovered(slot: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.backupRun.id })
    .from(schema.backupRun)
    .where(
      and(
        gte(schema.backupRun.startedAt, slot),
        or(eq(schema.backupRun.trigger, 'schedule'), eq(schema.backupRun.status, 'succeeded')),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The job: runs a backup when backups are on and today's slot has not been
 * covered yet. Ticks every few minutes, so a missed slot (the API was down)
 * is caught up as soon as it is back.
 */
export async function runScheduledBackup(now = new Date()): Promise<number> {
  const settings = await backupSettings();
  if (!settings.enabled) return 0;
  if (await slotCovered(scheduledSlot(now, settings.hourUtc))) return 0;
  await performBackup({ trigger: 'schedule' });
  return 1;
}

/** A manual backup under the job lock; resolves when it has finished. Null if one was already running. */
export async function runManualBackup(actor: Actor): Promise<number | null> {
  return runExclusively({
    name: BACKUP_JOB,
    intervalMs: 0,
    run: () => performBackup({ trigger: 'manual', actor }).then(() => 1),
  });
}

/** Starts a manual backup in the background. */
export async function startManualBackup(actor: Actor): Promise<'started' | 'running'> {
  const [running] = await db
    .select({ id: schema.backupRun.id })
    .from(schema.backupRun)
    .where(eq(schema.backupRun.status, 'running'))
    .limit(1);
  if (running) return 'running';
  void runManualBackup(actor).catch((error: unknown) =>
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Manual backup failed',
    ),
  );
  return 'started';
}

const isoOrNull = (value: Date | null) => value?.toISOString() ?? null;

export function toBackupRunView(row: RunRow): BackupRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: isoOrNull(row.finishedAt),
    destination: row.destination,
    dumpKey: row.dumpKey,
    dumpBytes: row.dumpBytes,
    dumpSha256: row.dumpSha256,
    manifestKey: row.manifestKey,
    attachmentCount: row.attachmentCount,
    attachmentBytes: row.attachmentBytes,
    missingObjects: row.missingObjects,
    verified: row.verified,
    verificationDetail: row.verificationDetail,
    errorMessage: row.errorMessage,
    prunedAt: isoOrNull(row.prunedAt),
  };
}

export async function recentBackupRuns(limit = 20): Promise<RunRow[]> {
  return db.select().from(schema.backupRun).orderBy(desc(schema.backupRun.startedAt)).limit(limit);
}

export async function lastSuccessfulBackup(): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(schema.backupRun)
    .where(eq(schema.backupRun.status, 'succeeded'))
    .orderBy(desc(schema.backupRun.startedAt))
    .limit(1);
  return row ?? null;
}

/** Everything the Backups page shows. */
export async function backupStatus(now = new Date()): Promise<BackupStatus> {
  const settings = await backupSettings();
  const [issues, version, runs, lastSuccess, storage] = await Promise.all([
    backupConfigurationIssues(settings),
    pgDumpVersion(),
    recentBackupRuns(20),
    lastSuccessfulBackup(),
    getSetting('storage'),
  ]);
  let nextRunAt: string | null = null;
  if (settings.enabled) {
    const slot = scheduledSlot(now, settings.hourUtc);
    nextRunAt = (await slotCovered(slot))
      ? new Date(slot.getTime() + 24 * 60 * 60_000).toISOString()
      : now.toISOString();
  }
  return {
    settings: toPublicBackupSettings(settings),
    issues: version
      ? issues
      : [
          ...issues,
          'pg_dump was not found on this server. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.',
        ],
    pgDumpVersion: version,
    attachmentStorage: {
      driver: storage.driver,
      bucket: storage.driver === 's3' ? storage.s3.bucket || null : null,
    },
    running: runs.some((run) => run.status === 'running'),
    nextRunAt,
    lastSuccessAt: isoOrNull(lastSuccess?.finishedAt ?? null),
    runs: runs.map(toBackupRunView),
  };
}

/** Writes, reads back and deletes a small object at the destination. */
export async function testBackupTarget(settings: ResolvedBackupSettings): Promise<void> {
  const target = await resolveBackupTarget(settings);
  const key = `${target.root}.oci-write-test-${Date.now()}`;
  const body = Buffer.from(`oci backup destination check ${new Date().toISOString()}`);
  await target.driver.putStream(key, Readable.from([body]), 'text/plain');
  try {
    const stored = await target.driver.get(key);
    if (!stored.equals(body)) throw new Error('The test object did not read back correctly.');
  } finally {
    await target.driver.delete(key).catch(() => undefined);
  }
}
