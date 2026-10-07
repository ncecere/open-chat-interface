import { Readable } from 'node:stream';
import { desc, eq, schema } from '@oci/db';
import type { BackupRun, BackupStatus } from '@oci/shared';
import { db } from '../../db/index.js';
import { getSetting } from '../settings.js';
import { pgDumpVersion } from './pg-tools.js';
import { scheduledSlot, slotCovered } from './schedule.js';
import {
  backupConfigurationIssues,
  backupSettings,
  type ResolvedBackupSettings,
  resolveBackupTarget,
  toPublicBackupSettings,
} from './settings.js';

export type RunRow = typeof schema.backupRun.$inferSelect;

const isoOrNull = (value: Date | null) => value?.toISOString() ?? null;

function toBackupRunView(row: RunRow): BackupRun {
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
    files:
      row.copiedObjects === null
        ? null
        : {
            copiedObjects: row.copiedObjects,
            copiedBytes: row.copiedBytes ?? 0,
            skippedObjects: row.skippedObjects ?? 0,
            skippedBytes: row.skippedBytes ?? 0,
            verifiedObjects: row.verifiedObjects ?? 0,
            sweptObjects: row.sweptObjects,
          },
    verified: row.verified,
    verificationDetail: row.verificationDetail,
    errorMessage: row.errorMessage,
    prunedAt: isoOrNull(row.prunedAt),
  };
}

async function recentBackupRuns(limit = 20): Promise<RunRow[]> {
  return db.select().from(schema.backupRun).orderBy(desc(schema.backupRun.startedAt)).limit(limit);
}

async function lastSuccessfulBackup(): Promise<RunRow | null> {
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
