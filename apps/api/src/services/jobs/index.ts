import { BACKUP_JOB, runScheduledBackup } from '../backups/run.js';
import { COMPLIANCE_JOB, runScheduledComplianceExport } from '../compliance/export.js';
import {
  applyThreadRetention,
  pruneAuditLog,
  pruneAuthArtifacts,
  pruneExpiredQuotaOverrides,
  pruneShareLinks,
  pruneUsageEvents,
} from '../lifecycle/retention.js';
import { purgeExpiredTrash } from '../lifecycle/trash.js';
import { applyMemoryRetention } from '../memory/store.js';
import { processPendingImports } from '../portability/imports.js';
import { embedPendingProjectPassages } from '../project-search/embedding.js';
import { indexPendingProjectFiles } from '../project-search/indexing.js';
import { sweepAbandonedReservations } from '../quota/index.js';
import { runDueReports } from '../reports.js';
import { recomputeStorageUsage } from '../storage/quota.js';
import { drainDeletedObjects, pruneDrainedObjects } from '../storage/reaper.js';
import { purgeExpiredTemporaryThreads } from '../threads.js';
import { processWebhookDeliveries } from '../webhooks/delivery.js';
import { type JobDefinition, runExclusively, startJobs } from './runner.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Every recurring maintenance task, with a per-job advisory lock preventing
 * overlap while its owning session is alive. Ticks are not durable claims:
 * staggered replicas may run sequentially, so jobs still need safe retries.
 */
export function lifecycleJobs(): JobDefinition[] {
  return [
    {
      name: 'reports.send-due',
      // Hourly rather than daily: due-ness is decided from the last send, so a
      // frequent tick simply notices sooner rather than sending more often.
      intervalMs: HOUR,
      run: () => runDueReports(),
    },
    {
      name: 'storage.drain-deleted-objects',
      // Frequent: this is what actually frees disk after a deletion.
      intervalMs: 5 * MINUTE,
      run: () => drainDeletedObjects(),
    },
    {
      // Uploads also kick this immediately; the tick resumes anything a
      // restart interrupted and anything queued while another import ran.
      name: 'imports.process',
      intervalMs: MINUTE,
      run: () => processPendingImports(),
    },
    {
      // Uploads index their own file; this chunks files added before v0.8
      // and retries any upload whose indexing failed, a bounded batch a tick.
      name: 'projects.index-files',
      intervalMs: 5 * MINUTE,
      run: () => indexPendingProjectFiles(),
    },
    {
      // Meaning-based search (v0.9): embeds passages that have no embedding
      // from the current model, a bounded batch a tick. Does nothing unless an
      // embeddings model is configured and pgvector is enabled.
      name: 'projects.embed-passages',
      intervalMs: 5 * MINUTE,
      run: () => embedPendingProjectPassages(),
    },
    {
      name: 'quota.sweep-reservations',
      intervalMs: 5 * MINUTE,
      run: () => sweepAbandonedReservations(),
    },
    {
      name: 'threads.purge-temporary',
      intervalMs: HOUR,
      run: () => purgeExpiredTemporaryThreads(),
    },
    {
      name: 'trash.purge-expired',
      intervalMs: HOUR,
      run: () => purgeExpiredTrash(),
    },
    {
      name: 'retention.threads',
      intervalMs: 6 * HOUR,
      run: () => applyThreadRetention(),
    },
    {
      // User memory (v0.9): does nothing unless memory retention is set.
      name: 'retention.memories',
      intervalMs: 24 * HOUR,
      run: () => applyMemoryRetention(),
    },
    {
      name: 'retention.usage-events',
      intervalMs: 24 * HOUR,
      run: () => pruneUsageEvents(),
    },
    {
      name: 'retention.audit-log',
      intervalMs: 24 * HOUR,
      run: () => pruneAuditLog(),
    },
    {
      name: 'retention.share-links',
      intervalMs: 24 * HOUR,
      run: () => pruneShareLinks(),
    },
    {
      name: 'retention.auth-artifacts',
      intervalMs: 24 * HOUR,
      run: () => pruneAuthArtifacts(),
    },
    {
      // Housekeeping only: a lapsed override already stops applying when a
      // limit is read, so this never decides enforcement.
      name: 'retention.quota-overrides',
      intervalMs: 24 * HOUR,
      run: () => pruneExpiredQuotaOverrides(),
    },
    {
      name: 'storage.prune-drained-objects',
      intervalMs: 24 * HOUR,
      run: () => pruneDrainedObjects(new Date(Date.now() - 7 * 24 * HOUR)),
    },
    {
      name: 'storage.recompute-usage',
      // Counters are maintained on the hot path; this only repairs drift left
      // by a crash between the blob write and the counter update.
      intervalMs: 24 * HOUR,
      run: () => recomputeStorageUsage(),
    },
    {
      // Audit events kick this straight away; the tick sends retries as they
      // fall due and anything queued while another replica held the lock.
      name: 'webhooks.deliver',
      intervalMs: MINUTE,
      run: () => processWebhookDeliveries(),
    },
    {
      // Checks whether today's backup slot is due; does nothing when backups
      // are off. The lock keeps scheduled and manual backups from overlapping.
      name: BACKUP_JOB,
      intervalMs: 10 * MINUTE,
      run: () => runScheduledBackup(),
    },
    {
      // Exports audit events (and, when turned on, conversation content) when
      // the hourly or daily slot is due; does nothing when the export is off.
      // The lock keeps scheduled and manual exports from overlapping.
      name: COMPLIANCE_JOB,
      intervalMs: 5 * MINUTE,
      run: () => runScheduledComplianceExport(),
    },
  ];
}

export function startLifecycleJobs(): void {
  startJobs(lifecycleJobs());
}

/** Runs one job immediately, for admin-triggered maintenance. */
export async function runJobNow(name: string): Promise<number | null> {
  const job = lifecycleJobs().find((candidate) => candidate.name === name);
  if (!job) return null;
  return runExclusively(job);
}

export { recentJobRuns, stopJobs } from './runner.js';
