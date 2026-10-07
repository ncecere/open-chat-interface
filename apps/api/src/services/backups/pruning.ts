import { and, eq, isNotNull, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { sweepBackupObjects } from './files.js';
import { selectBackupsToKeep } from './retention.js';
import { type BackupTarget, type ResolvedBackupSettings, resolveBackupTarget } from './settings.js';

/** The sweep deletes only copies older than this (see `sweepBackupObjects`). */
export const SWEEP_GRACE_MS = 24 * 60 * 60_000;

/** Removes what a failed run managed to write; best effort. */
export async function cleanupObjects(
  settings: ResolvedBackupSettings,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  let target: BackupTarget;
  try {
    target = await resolveBackupTarget(settings);
  } catch {
    return;
  }
  for (const key of keys) await target.driver.delete(key).catch(() => undefined);
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

/**
 * After retention: deletes copies at this destination that no retained
 * backup which copied files references. Null when it could not run (it is
 * retried after the next backup); never fails the backup.
 */
export async function sweepCopies(
  settings: ResolvedBackupSettings,
  target: BackupTarget,
  olderThan: Date,
): Promise<number | null> {
  try {
    const retained = await db
      .select({ attachmentsKey: schema.backupRun.attachmentsKey })
      .from(schema.backupRun)
      .where(
        and(
          eq(schema.backupRun.status, 'succeeded'),
          isNull(schema.backupRun.prunedAt),
          isNotNull(schema.backupRun.copiedObjects),
          eq(schema.backupRun.destination, settings.destination),
          eq(schema.backupRun.keyPrefix, target.root),
        ),
      );
    const swept = await sweepBackupObjects(
      target,
      retained.flatMap((run) => (run.attachmentsKey ? [run.attachmentsKey] : [])),
      olderThan,
    );
    if (swept > 0) logger.info({ swept }, 'Deleted backup file copies no backup references');
    return swept;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not sweep backup file copies; will retry after the next backup',
    );
    return null;
  }
}
