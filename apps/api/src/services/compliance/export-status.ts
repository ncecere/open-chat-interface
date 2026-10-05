import { desc, eq, schema } from '@oci/db';
import type { ComplianceRun, ComplianceStatus } from '@oci/shared';
import { db } from '../../db/index.js';
import { getSetting } from '../settings.js';
import { exportCursor } from './cursor.js';
import { complianceSlot, DAY_MS, HOUR_MS, slotCovered } from './export-schedule.js';
import { listLegalHolds } from './holds.js';
import {
  complianceConfigurationIssues,
  complianceSettings,
  toPublicComplianceSettings,
} from './settings.js';

export type RunRow = typeof schema.complianceExportRun.$inferSelect;

const num = (value: number | string | null) => (value === null ? null : Number(value));

function toComplianceRunView(row: RunRow): ComplianceRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    destination: row.destination,
    includeContent: row.includeContent,
    audit: {
      key: row.auditKey,
      afterSeq: num(row.auditAfterSeq),
      throughSeq: num(row.auditThroughSeq),
      count: row.auditCount,
      bytes: num(row.auditBytes),
      sha256: row.auditSha256,
    },
    messages: row.includeContent
      ? {
          key: row.messagesKey,
          afterSeq: num(row.messagesAfterSeq),
          throughSeq: num(row.messagesThroughSeq),
          count: row.messageCount,
          bytes: num(row.messagesBytes),
          sha256: row.messagesSha256,
        }
      : null,
    manifestKey: row.manifestKey,
    verified: row.verified,
    errorMessage: row.errorMessage,
    prunedAt: row.prunedAt?.toISOString() ?? null,
  };
}

async function recentComplianceRuns(limit = 20): Promise<RunRow[]> {
  return db
    .select()
    .from(schema.complianceExportRun)
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(limit);
}

async function lastSuccessfulComplianceRun(): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(schema.complianceExportRun)
    .where(eq(schema.complianceExportRun.status, 'succeeded'))
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(1);
  return row ?? null;
}

/** Everything the Compliance page shows. */
export async function complianceStatus(now = new Date()): Promise<ComplianceStatus> {
  const settings = await complianceSettings();
  const [issues, runs, lastSuccess, storage, auditCursor, messagesCursor, holds] =
    await Promise.all([
      complianceConfigurationIssues(settings),
      recentComplianceRuns(20),
      lastSuccessfulComplianceRun(),
      getSetting('storage'),
      exportCursor('audit'),
      exportCursor('messages'),
      listLegalHolds({ includeLifted: true, limit: 100 }),
    ]);
  let nextRunAt: string | null = null;
  if (settings.enabled) {
    const slot = complianceSlot(now, settings.schedule, settings.hourUtc);
    nextRunAt = (await slotCovered(slot, now))
      ? new Date(slot.getTime() + (settings.schedule === 'hourly' ? HOUR_MS : DAY_MS)).toISOString()
      : now.toISOString();
  }
  return {
    settings: toPublicComplianceSettings(settings),
    issues,
    attachmentStorage: {
      driver: storage.driver,
      bucket: storage.driver === 's3' ? storage.s3.bucket || null : null,
    },
    running: runs.some((run) => run.status === 'running'),
    nextRunAt,
    lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
    cursor: { audit: auditCursor ?? 0, messages: messagesCursor },
    runs: runs.map(toComplianceRunView),
    holds,
  };
}
