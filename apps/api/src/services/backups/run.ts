import { eq, schema, sql } from '@oci/db';
import { BACKUP_FILE_SAMPLE_SIZE, BACKUP_STORAGE_PREFIX } from '@oci/shared';
import { controlDatabaseUrl } from '../../db/control.js';
import { db } from '../../db/index.js';
import { errorText } from '../../lib/log-redaction.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { recordAudit } from '../audit.js';
import { assertManualRunPlaced, requestManualRun } from '../jobs/requests.js';
import { runExclusively } from '../jobs/runner.js';
import { backupDuration, backupRuns } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';
import { BackupError, dumpDatabase, measured, sha256, verifyDump, verifyManifest } from './dump.js';
import { BACKUP_OBJECTS_FOLDER, verifyBackupObjects } from './files.js';
import { attachmentManifest, type ManifestTotals } from './manifest.js';
import { scrubSecret } from './pg-tools.js';
import { cleanupObjects, pruneBackups, SWEEP_GRACE_MS, sweepCopies } from './pruning.js';
import { scheduledSlot, slotCovered } from './schedule.js';
import { backupSettings, resolveBackupTarget } from './settings.js';
import type { RunRow } from './status.js';

export { pruneBackups } from './pruning.js';
export { scheduledSlot } from './schedule.js';
export { backupStatus, testBackupTarget } from './status.js';

/**
 * Automated backups: a `pg_dump` archive (custom format), a manifest of
 * attachment objects and, when copying files is on, copies of those objects
 * (see files.ts), written to S3-compatible storage by the job runner, then
 * read back and verified. See docs/admin/backups.md.
 *
 * Nothing is held in memory whole: the dump streams from `pg_dump` into a
 * multipart upload, the manifest is produced a page of attachments at a time,
 * files stream from attachment storage to the destination, and verification
 * streams the stored archive back through `pg_restore`.
 */

export const BACKUP_JOB = 'backups.run';

type Actor = { id: string; email: string } | null;

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
 * Runs one backup now: dump, manifest (copying files when that is on),
 * verification, then retention and the sweep of unreferenced copies. Records
 * the run, its metrics and a `backup.run` audit entry, and rethrows a failure
 * so the job run is marked failed too. Callers hold the backup job lock.
 */
export async function performBackup(options: {
  trigger: 'schedule' | 'manual';
  actor?: Actor;
  databaseUrl?: string;
  /** How old an unreferenced copy must be before the sweep deletes it; tests shorten it. */
  sweepGraceMs?: number;
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
        // pg_dump sets session parameters: a control connection, never a
        // transaction-mode pooler (v0.11 design, section 11).
        options.databaseUrl ?? controlDatabaseUrl(),
      );

      const totals: ManifestTotals = {
        count: 0,
        bytes: 0,
        missing: 0,
        files: settings.copyFiles
          ? { copiedObjects: 0, copiedBytes: 0, skippedObjects: 0, skippedBytes: 0 }
          : null,
      };
      const manifestFile = { bytes: 0, hash: sha256() };
      written.push(attachmentsKey);
      // Copies are not in `written`: they are shared by content with other
      // backups, so a failed run leaves them for the sweep.
      await target.driver.putStream(
        attachmentsKey,
        measured(attachmentManifest(totals, settings.copyFiles ? target : null), manifestFile),
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
              // Copies live beside the backup folders, in `objects/<sha256>`.
              files: totals.files
                ? {
                    copied: true,
                    folder: BACKUP_OBJECTS_FOLDER,
                    verification: settings.verifyFiles,
                    ...totals.files,
                  }
                : { copied: false },
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
      let filesChecked: number | null = null;
      if (totals.files) {
        const files = await verifyBackupObjects(
          target,
          attachmentsKey,
          settings.verifyFiles,
          BACKUP_FILE_SAMPLE_SIZE,
        );
        if (files.failed > 0)
          throw new BackupError(
            `Verification failed: ${files.failed} of ${files.checked} copied attachment files checked are missing at the destination or do not match their checksum.`,
          );
        filesChecked = files.checked;
      }

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
          ...(totals.files
            ? {
                ...totals.files,
                verifiedObjects: filesChecked ?? 0,
              }
            : {}),
          verified: true,
          verificationDetail: `${detail}; ${totals.count} attachment objects checksummed${
            totals.missing ? `, ${totals.missing} missing` : ''
          }${
            totals.files
              ? `; ${totals.files.copiedObjects} files copied, ${totals.files.skippedObjects} already at the destination, ${filesChecked} read back and checksummed`
              : ''
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
          ...(totals.files
            ? {
                copiedObjects: totals.files.copiedObjects,
                copiedBytes: totals.files.copiedBytes,
              }
            : {}),
          verified: true,
        },
      });

      const retained = await pruneBackups(settings, target).then(
        () => true,
        (error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'Backup retention failed',
          );
          return false;
        },
      );
      if (!retained) return finished!;
      const swept = await sweepCopies(
        settings,
        target,
        new Date(Date.now() - (options.sweepGraceMs ?? SWEEP_GRACE_MS)),
      );
      if (swept === null) return finished!;
      const [after] = await db
        .update(schema.backupRun)
        .set({ sweptObjects: swept })
        .where(eq(schema.backupRun.id, run!.id))
        .returning();
      return after ?? finished!;
    });
  } catch (error) {
    const message =
      error instanceof BackupError ? error.message : `Backup failed: ${errorText(error)}`;
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
    const parsed = new URL(url ?? controlDatabaseUrl());
    return parsed.password ? decodeURIComponent(parsed.password) : null;
  } catch {
    return null;
  }
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
async function runManualBackup(actor: Actor): Promise<number | null> {
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
  // On a `web` replica (v0.11) a worker runs it.
  // 'started' only once a worker has taken it (#265).
  const placed = assertManualRunPlaced(
    await requestManualRun({ job: BACKUP_JOB, actor: actor ?? undefined }),
  );
  if (placed === 'queued') return 'started';
  void runManualBackup(actor).catch((error: unknown) =>
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Manual backup failed',
    ),
  );
  return 'started';
}
