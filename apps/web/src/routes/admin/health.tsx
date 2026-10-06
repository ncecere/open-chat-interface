import type { BackgroundJob, JobRun, ObservabilityStatus } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleDashed, Play, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  LoadError,
  MutationError,
  Notice,
  SettingsSection,
} from '~/components/admin/admin-ui';
import { MaintenanceMode } from '~/components/admin/maintenance-mode';
import { Replicas } from '~/components/admin/operations/replicas';
import { RUNNING_ICON_CLASS, RunningIcon } from '~/components/admin/operations/runs';
import { BackgroundWorkSection, UpgradesSection } from '~/components/admin/upgrades';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatReadOnlyTime } from '~/lib/read-only';
import { cn, formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

type Status = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

interface HealthResponse {
  status: Status;
  checks: Check[];
  /** Absent from servers older than v0.9. */
  observability?: ObservabilityStatus;
}

interface StorageHealth {
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
  pendingDeletions: number;
}

interface ReconcileReport {
  orphanedObjects: number;
  missingObjects: number;
  queuedForDeletion: number;
}

const STATUS_STYLES: Record<Status, { icon: typeof CircleCheck; className: string }> = {
  ok: { icon: CircleCheck, className: 'text-[var(--success)]' },
  warn: { icon: TriangleAlert, className: 'text-[var(--warning)]' },
  error: { icon: CircleAlert, className: 'text-[var(--danger)]' },
};

const STATUS_LABELS: Record<Status, string> = { ok: 'OK', warn: 'Warning', error: 'Error' };

const SUMMARY: Record<Status, string> = {
  ok: 'Everything is responding normally.',
  warn: 'Working, with something worth looking at.',
  error: 'Something is broken and users are affected.',
};

/** A job's schedule in words: "every 15 seconds", "every hour", "every 6 hours". */
function formatJobInterval(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1000, 'day'],
    [60 * 60 * 1000, 'hour'],
    [60 * 1000, 'minute'],
    [1000, 'second'],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
    }
  }
  return `every ${ms} ms`;
}

/** A job run as one line (shown and as its tooltip, #130). */
function runSummary(entry: JobRun): string {
  return [
    formatRelativeTime(entry.startedAt),
    entry.durationMs === null ? '' : ` · ${entry.durationMs} ms`,
    ` · ${entry.itemsProcessed} item${entry.itemsProcessed === 1 ? '' : 's'}`,
    entry.errorMessage ? ` · ${entry.errorMessage}` : '',
  ].join('');
}

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;

/**
 * A check's detail with each time in it in the reader's local time. The API
 * writes ISO 8601 instants, since it does not know where the reader is; the
 * Read-only row read "until 2026-10-06T05:39:00.000Z" while the Maintenance
 * card beside it said "until about 01:39 AM EDT" (#259). Exported for tests.
 */
export function localTimesIn(detail: string, now = new Date()): string {
  return detail.replace(ISO_INSTANT, (iso) =>
    Number.isNaN(Date.parse(iso)) ? iso : formatReadOnlyTime(iso, now),
  );
}

function HealthChecks() {
  const health = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api.get<HealthResponse>('/admin/health'),
    // Stale quickly: this page is opened precisely when something is suspected
    // to be wrong, and a cached green summary would be actively misleading.
    refetchInterval: 30_000,
  });
  const { data, isLoading } = health;

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading health checks">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  }

  if (!data) return <LoadError title="Health checks could not be loaded." query={health} />;

  const Overall = STATUS_STYLES[data.status].icon;

  return (
    <div>
      <div className="flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
        <Overall
          className={cn('size-5 shrink-0', STATUS_STYLES[data.status].className)}
          aria-hidden="true"
        />
        <p className="font-medium text-sm">{SUMMARY[data.status]}</p>
      </div>

      <ul className="mt-4 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
        {data.checks.map((check) => {
          const Icon = STATUS_STYLES[check.status].icon;
          return (
            <li key={check.id} className="flex items-start gap-3 px-4 py-3">
              <Icon
                className={cn('mt-0.5 size-4 shrink-0', STATUS_STYLES[check.status].className)}
                aria-label={STATUS_LABELS[check.status]}
                role="img"
              />
              <div className="min-w-0">
                <p className="font-medium text-sm">{check.label}</p>
                <p className="text-[var(--text-muted)] text-xs">{localTimesIn(check.detail)}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Metrics and traces are configured by environment variables; this only reports them. */
function Observability() {
  // Shares the health query, so this costs no extra request.
  const health = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api.get<HealthResponse>('/admin/health'),
    refetchInterval: 30_000,
  });
  const status = health.data?.observability;
  if (!status) return null;
  const rows = [
    {
      label: 'Prometheus metrics',
      on: status.metrics,
      detail: status.metrics
        ? 'Served at /metrics on each API replica, for scrapers presenting METRICS_TOKEN.'
        : 'Off. Set METRICS_TOKEN to serve /metrics.',
    },
    {
      label: 'OpenTelemetry traces',
      on: status.tracing,
      detail: status.tracing
        ? `Exported over OTLP to ${status.tracingEndpoint ?? 'the configured collector'}.`
        : 'Off. Set OTEL_EXPORTER_OTLP_ENDPOINT to export traces.',
    },
  ];
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {rows.map((row) => (
        <li key={row.label} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="font-medium text-sm">{row.label}</p>
            <p className="text-[var(--text-muted)] text-xs">{row.detail}</p>
          </div>
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">
            {row.on ? 'On' : 'Off'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How often runs are read while one is followed (#282). */
const JOB_FOLLOW_MS = 2_000;
/** How long after Run, and how long into a run, it is followed. */
const JOB_FOLLOW_FOR_MS = 15_000;
const JOB_RUNNING_FOLLOW_MS = 5 * 60_000;

/**
 * Whether the list is read again soon: a run just asked for, or one that
 * started a short while ago and is still running. Run returns once a worker
 * takes the request (#265), so the list read straight after it shows the run
 * starting; a job that then took 20 ms kept its "Running" warning until the
 * next read, 30 seconds later (#282).
 */
function followingRuns(jobs: BackgroundJob[] | undefined, until: number, now = Date.now()) {
  if (now < until) return true;
  return (jobs ?? []).some(
    (job) =>
      job.lastRun?.status === 'running' &&
      now - new Date(job.lastRun.startedAt).getTime() < JOB_RUNNING_FOLLOW_MS,
  );
}

function BackgroundJobs() {
  const queryClient = useQueryClient();
  const [followUntil, setFollowUntil] = useState(0);

  const jobs = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => api.get<{ jobs: BackgroundJob[] }>('/admin/lifecycle/jobs'),
    refetchInterval: (query) =>
      followingRuns(query.state.data?.jobs, followUntil) ? JOB_FOLLOW_MS : 30_000,
  });
  const { data, isLoading } = jobs;

  const run = useMutation({
    mutationFn: (name: string) => api.post(`/admin/lifecycle/jobs/${name}/run`),
    onSuccess: () => {
      setFollowUntil(Date.now() + JOB_FOLLOW_FOR_MS);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'storage-health'] }),
      ]);
    },
  });

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading background jobs">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  }

  if (!data) return <LoadError title="Background jobs could not be loaded." query={jobs} />;

  // Every registered job, run or not, so each has its Run button (#215).
  const list = [...data.jobs].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <MutationError
        error={run.error}
        message={`${run.variables ?? 'The job'} could not be started.`}
        className="mb-3"
      />
      <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
        {list.map((job) => {
          const entry = job.lastRun;
          const failed = entry?.status === 'error';
          const running = entry?.status === 'running';
          const Icon = !entry
            ? CircleDashed
            : failed
              ? CircleAlert
              : running
                ? RunningIcon
                : CircleCheck;
          const summary = `${entry ? runSummary(entry) : 'Not run yet'} · runs ${formatJobInterval(job.intervalMs)}`;
          return (
            <li key={job.name} className="flex items-center gap-3 px-4 py-3">
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  !entry
                    ? 'text-[var(--text-muted)]'
                    : failed
                      ? 'text-[var(--danger)]'
                      : running
                        ? RUNNING_ICON_CLASS
                        : 'text-[var(--success)]',
                )}
                aria-label={
                  !entry ? 'Not run yet' : failed ? 'Failed' : running ? 'Running' : 'Succeeded'
                }
                role="img"
              />

              <div className="min-w-0 flex-1">
                {/* Wrapped, not cut short: a phone cannot show a tooltip, and the
                    schedule is at the end of the line (#215). */}
                <p className="break-all font-mono text-xs">{job.name}</p>
                <p className="break-words text-[var(--text-muted)] text-xs">{summary}</p>
              </div>

              <EditOnly>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Run ${job.name} now`}
                  disabled={run.isPending}
                  onClick={() => run.mutate(job.name)}
                >
                  {run.isPending && run.variables === job.name ? <Spinner /> : <Play />}
                  Run
                </Button>
              </EditOnly>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StorageInUse() {
  const health = useQuery({
    queryKey: ['admin', 'storage-health'],
    queryFn: () => api.get<StorageHealth>('/admin/lifecycle/storage-health'),
  });

  if (health.isLoading) {
    return (
      <div role="status" aria-label="Loading storage usage">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  }
  if (!health.data) return <LoadError title="Storage usage could not be loaded." query={health} />;

  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <div>
        <dt className="text-[var(--text-muted)] text-xs">In use</dt>
        <dd className="mt-1 font-semibold text-lg">{formatBytes(health.data.liveBytes)}</dd>
        <dd className="text-[var(--text-muted)] text-xs">
          {health.data.liveFileCount.toLocaleString()} files
        </dd>
      </div>
      <div>
        <dt className="text-[var(--text-muted)] text-xs">Pending deletion</dt>
        <dd className="mt-1 font-semibold text-lg">{formatBytes(health.data.pendingBytes)}</dd>
        <dd className="text-[var(--text-muted)] text-xs">
          {health.data.pendingFileCount.toLocaleString()} files in trash
        </dd>
      </div>
      <div>
        <dt className="text-[var(--text-muted)] text-xs">Objects queued for removal</dt>
        <dd className="mt-1 font-semibold text-lg">
          {health.data.pendingDeletions.toLocaleString()}
        </dd>
        <dd className="text-[var(--text-muted)] text-xs">Cleared by the cleanup job</dd>
      </div>
    </dl>
  );
}

function StorageReconcile() {
  const queryClient = useQueryClient();
  const [report, setReport] = useState<ReconcileReport | null>(null);

  const reconcile = useMutation({
    mutationFn: (deleteOrphans: boolean) =>
      api.post<ReconcileReport>(
        `/admin/lifecycle/storage-reconcile${deleteOrphans ? '?deleteOrphans=true' : ''}`,
      ),
    onSuccess: async (result) => {
      setReport(result);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'storage-health'] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <EditOnly>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate(false)}
          >
            {reconcile.isPending && <Spinner />}
            Check for orphans
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={reconcile.isPending || !report || report.orphanedObjects === 0}
            onClick={() => reconcile.mutate(true)}
          >
            Queue orphans for deletion
          </Button>
        </div>
      </EditOnly>

      <MutationError
        error={reconcile.error}
        message={
          reconcile.variables
            ? 'Orphaned objects could not be queued for deletion.'
            : 'The storage check could not be completed.'
        }
      />

      {report && (
        <dl className="grid gap-4 sm:grid-cols-3" aria-live="polite">
          <div>
            <dt className="text-[var(--text-muted)] text-xs">Objects with no record</dt>
            <dd className="mt-1 font-semibold text-lg">{report.orphanedObjects}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)] text-xs">Records with no object</dt>
            <dd className="mt-1 font-semibold text-lg">{report.missingObjects}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)] text-xs">Queued for deletion</dt>
            <dd className="mt-1 font-semibold text-lg">{report.queuedForDeletion}</dd>
          </div>
        </dl>
      )}

      <Notice title="Records with no object are reported, not repaired">
        Deleting those rows would destroy a conversation's attachment metadata over what may be a
        temporary storage fault, so they are left for an operator to investigate. Objects newer than
        24 hours are never treated as orphans, because an upload writes its file before committing
        its record.
      </Notice>
    </div>
  );
}

export function AdminHealthPage() {
  return (
    <div>
      <AdminPageHeader
        title="System health"
        description="Whether the parts this instance depends on are working, read-only maintenance mode, the background jobs that keep it tidy, upgrades and background migrations, and storage integrity."
      />

      <div className="flex flex-col gap-10 pb-10">
        <SettingsSection
          editable={false}
          title="Health checks"
          description="Refreshed every 30 seconds while this page is open."
        >
          <HealthChecks />
        </SettingsSection>

        <MaintenanceMode />

        <Replicas />

        <SettingsSection
          editable={false}
          title="Observability"
          description="Metrics and traces are set with environment variables on the API; see the administrator guide."
        >
          <Observability />
        </SettingsSection>

        <SettingsSection
          editable={false}
          title="Background jobs"
          description="Every scheduled job, how often it runs, and its most recent run. Jobs hold a lock while running, so each runs on one replica at a time."
        >
          <BackgroundJobs />
        </SettingsSection>

        <SettingsSection
          editable={false}
          title="Upgrades"
          description="What upgrading this database involves: pending migrations, post-deploy steps and the indexes they build, and whether the upgrade can be rolling. Run `node dist/scripts/upgrade-check.js` from a new release's image for the same check before deploying it."
        >
          <UpgradesSection />
        </SettingsSection>

        <SettingsSection
          editable={false}
          title="Background work"
          description="Background migrations rewrite existing rows in small batches while the instance serves, pausing when replication lags or a long transaction is open. Administrators can pause them or change their pace."
        >
          <BackgroundWorkSection />
        </SettingsSection>

        <SettingsSection
          editable={false}
          title="Storage in use"
          description="Deleted files still occupy disk until their trash window elapses and cleanup removes them."
        >
          <StorageInUse />
        </SettingsSection>

        <SettingsSection
          editable={false}
          title="Storage reconciliation"
          description="Compares object storage against the database in both directions to find files with no record and records with no file."
        >
          <StorageReconcile />
        </SettingsSection>
      </div>
    </div>
  );
}
