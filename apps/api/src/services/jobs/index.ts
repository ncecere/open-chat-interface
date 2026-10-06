import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { runsBackgroundJobs } from '../../lib/role.js';
import { BACKUP_JOB, runScheduledBackup, startManualBackup } from '../backups/run.js';
import { processCompactionQueue } from '../chat/compaction-queue.js';
import { recoverInterruptedReplies } from '../chat/run-recovery.js';
import {
  COMPLIANCE_JOB,
  runScheduledComplianceExport,
  startManualComplianceExport,
} from '../compliance/export.js';
import { embeddingRebuildJobs } from '../embeddings/rebuild.js';
import { encryptionJobs } from '../encryption/rotation.js';
import {
  applyThreadRetention,
  pruneAuditLog,
  pruneAuthArtifacts,
  pruneExpiredQuotaOverrides,
  pruneShareLinks,
  pruneUsageEvents,
} from '../lifecycle/retention.js';
import { purgeExpiredTrash } from '../lifecycle/trash.js';
import { jobPausedByReadOnly } from '../maintenance/read-only.js';
import { applyMemoryRetention } from '../memory/store.js';
import { migrationJobs, POST_MIGRATIONS_JOB } from '../migrations/jobs.js';
import { processPendingImports } from '../portability/imports.js';
import { embedPendingProjectPassages } from '../project-search/embedding.js';
import { indexPendingProjectFiles } from '../project-search/indexing.js';
import { sweepAbandonedReservations } from '../quota/index.js';
import { runDueReports } from '../reports.js';
import { recomputeStorageUsage } from '../storage/quota.js';
import { drainDeletedObjects, pruneDrainedObjects } from '../storage/reaper.js';
import { purgeExpiredTemporaryThreads, purgeUnusedThreads } from '../threads.js';
import { foldUsageRollups, USAGE_ROLLUP_FOLD_JOB } from '../usage-report/rollup-fold.js';
import { processWebhookDeliveries } from '../webhooks/delivery.js';
import {
  assertManualRunPlaced,
  type JobRequest,
  listenForJobRequests,
  requestManualRun,
} from './requests.js';
import {
  type JobDefinition,
  runExclusively,
  setJobPauseCheck,
  startJobs,
  stopJobs as stopJobTimers,
} from './runner.js';
import { jobsOnWorkers, type ScheduledJob, SWEEP_JOB } from './workers.js';

// Read-only maintenance mode (v0.11 design, section 9): jobs that write pause,
// apart from those the administrator keeps running (backups, compliance
// exports, webhook deliveries and reply recovery by default). Ticks, kicks and
// "Run now" alike; a job running when it starts stops after its batch.
setJobPauseCheck(jobPausedByReadOnly);

const MINUTE = 60 * 1000;
export const COMPACTION_JOB = 'chat.compact-conversations';
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
      // Conversation summaries (v0.9) are made here, never while a reply
      // waits. Requests also kick a pass straight away; the tick picks up
      // retries as they fall due and requests left by a restart. Rows are
      // claimed with a lease, so replicas never summarise one thread twice.
      name: COMPACTION_JOB,
      intervalMs: MINUTE,
      run: () => processCompactionQueue(),
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
      // Replies whose producer stopped heartbeating (killed, crashed, cut off
      // by a shutdown past its grace) are saved as interrupted, so their
      // conversation takes new messages again (v0.11). A reader resuming the
      // reply, or a new message in its conversation, does the same at once.
      // Every 15 s: a reply whose resuming client is on an older replica
      // (during an upgrade) has only this to end it. Its recorded runs also
      // show System health that some replica runs jobs (jobs/workers.ts).
      name: SWEEP_JOB,
      intervalMs: 15 * 1000,
      run: () => recoverInterruptedReplies(),
    },
    {
      // Usage rollups (v0.11): folds the change log the usage_event triggers
      // write. Readers add what is not folded yet, so this is for speed only.
      name: USAGE_ROLLUP_FOLD_JOB,
      intervalMs: 30 * 1000,
      run: () => foldUsageRollups(),
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
      // Conversations started but never written in, left when a hand-over
      // from the home page failed (v0.10.2). A day old before they go.
      name: 'threads.purge-unused',
      intervalMs: HOUR,
      run: () => purgeUnusedThreads(),
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
      // Deliveries queued while no worker ran go out at start, not a minute later.
      runOnStart: true,
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
    // Background migrations and, on a single instance, post-deploy steps (v0.11).
    ...migrationJobs(),
    // Embedding generations (v0.11): fill after a model change, switch, drop.
    ...embeddingRebuildJobs(),
    // Encryption key rotation (v0.11): re-encrypt after ENCRYPTION_KEY changes.
    ...encryptionJobs(),
  ];
}

let stopListening: (() => Promise<void>) | null = null;

/**
 * What a `web` replica asked for (jobs/requests.ts): a manual backup or
 * compliance export with the administrator who started it, or a job to run
 * now. Unknown names are ignored.
 */
export async function handleJobRequest(request: JobRequest): Promise<unknown> {
  if (request.actor && request.job === BACKUP_JOB) return startManualBackup(request.actor);
  if (request.actor && request.job === COMPLIANCE_JOB)
    return startManualComplianceExport(request.actor);
  // Dropped without a word, a request for a job this replica does not
  // schedule looked like a run that never came (#256).
  if (!isLifecycleJob(request.job))
    logger.warn({ job: request.job }, 'Ignored a request to run a job this replica does not run');
  return runJobNow(request.job);
}

/**
 * Whether this replica can run what a request asks for: a manual run it
 * cannot is left unanswered, so the web replica reports it as not started
 * rather than queued (#256, #265).
 */
export function takesJobRequest(request: JobRequest): boolean {
  if (request.actor && (request.job === BACKUP_JOB || request.job === COMPLIANCE_JOB)) return true;
  return isLifecycleJob(request.job);
}

/** The jobs this replica schedules, as its heartbeat reports them (#256). */
export function scheduledHere(): ScheduledJob[] {
  return lifecycleJobs().map(({ name, intervalMs }) => ({ name, intervalMs }));
}

/**
 * The jobs System health lists: those scheduled where jobs run. A `web`
 * replica runs none, and its own settings can register a job no worker has
 * (#256), so it lists what the workers report, or its own list when they
 * cannot say.
 */
export async function scheduledJobs(): Promise<ScheduledJob[]> {
  if (runsBackgroundJobs()) return scheduledHere();
  return (await jobsOnWorkers()) ?? scheduledHere();
}

/** 409 for a job that exists, but that no replica running jobs schedules. */
function notScheduledConflict(name: string) {
  return conflict(
    name === POST_MIGRATIONS_JOB
      ? 'No replica that runs background jobs applies post-deploy steps here. Once every replica runs this release, run migrate --post (docker compose --profile tools run --rm migrate-post), or set RUN_POST_MIGRATIONS=true on the replica that runs jobs.'
      : `No replica that runs background jobs runs ${name}: their settings leave it off, so it cannot start.`,
  );
}

/**
 * Starts every job's timer, and listens for work requested by `web`
 * replicas. Only on a replica that runs jobs (OCI_ROLE=worker or all).
 */
export async function startLifecycleJobs(): Promise<void> {
  startJobs(lifecycleJobs());
  stopListening = await listenForJobRequests(handleJobRequest, takesJobRequest);
}

/** Stops the timers and the listener; jobs already running finish their batch. */
export function stopJobs(): void {
  stopJobTimers();
  const stop = stopListening;
  stopListening = null;
  void stop?.();
}

/** Runs one job immediately, for admin-triggered maintenance. */
export function isLifecycleJob(name: string): boolean {
  return lifecycleJobs().some((candidate) => candidate.name === name);
}

export async function runJobNow(name: string): Promise<number | null> {
  const job = lifecycleJobs().find((candidate) => candidate.name === name);
  if (!job) return null;
  return runExclusively(job);
}

/**
 * "Run now" from System health: here when this replica runs jobs, else asked
 * of a worker (`queued`, its result not known yet). 404 for an unknown job,
 * 409 when no replica runs jobs; null for one already running elsewhere.
 */
export async function runOrQueueJobNow(name: string): Promise<number | 'queued' | null> {
  const here = isLifecycleJob(name);
  if (runsBackgroundJobs()) {
    // An unknown name is a mistake, not a skip (#82).
    if (!here) throw notFound(`There is no job called ${name}`);
    return runJobNow(name);
  }
  // A worker runs it, so it must be one a worker schedules: queued otherwise,
  // it was audited as a run and nothing happened (#256).
  const onWorkers = await jobsOnWorkers();
  const known = onWorkers ? onWorkers.some((job) => job.name === name) : here;
  if (!known) {
    if (here || name === POST_MIGRATIONS_JOB) throw notScheduledConflict(name);
    throw notFound(`There is no job called ${name}`);
  }
  // Queued only once a worker has taken it: a request no worker hears is
  // lost, so it is refused with the reason instead (#265).
  assertManualRunPlaced(await requestManualRun({ job: name }));
  return 'queued';
}

export { latestJobRuns, runningJobCount } from './runner.js';
