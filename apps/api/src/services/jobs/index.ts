import {
  applyThreadRetention,
  pruneAuditLog,
  pruneAuthArtifacts,
  pruneExpiredQuotaOverrides,
  pruneShareLinks,
  pruneUsageEvents,
} from '../lifecycle/retention.js';
import { purgeExpiredTrash } from '../lifecycle/trash.js';
import { processPendingImports } from '../portability/imports.js';
import { sweepAbandonedReservations } from '../quota/index.js';
import { runDueReports } from '../reports.js';
import { recomputeStorageUsage } from '../storage/quota.js';
import { drainDeletedObjects, pruneDrainedObjects } from '../storage/reaper.js';
import { purgeExpiredTemporaryThreads } from '../threads.js';
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
