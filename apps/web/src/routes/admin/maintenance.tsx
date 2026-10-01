import type { JobRun } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  AdminPageHeader,
  LoadError,
  MutationError,
  Notice,
  SettingsSection,
} from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

interface ReconcileReport {
  orphanedObjects: number;
  missingObjects: number;
  queuedForDeletion: number;
}

function JobHealth() {
  const queryClient = useQueryClient();

  const jobs = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => api.get<{ runs: JobRun[] }>('/admin/lifecycle/jobs'),
    refetchInterval: 30_000,
  });
  const { data, isLoading } = jobs;

  const run = useMutation({
    mutationFn: (name: string) => api.post(`/admin/lifecycle/jobs/${name}/run`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
  });

  // One row per job, showing only its most recent run.
  const latest = new Map<string, JobRun>();
  for (const entry of data?.runs ?? []) {
    if (!latest.has(entry.jobName)) latest.set(entry.jobName, entry);
  }
  const runs = [...latest.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));

  if (isLoading) return <Spinner className="mx-auto size-5" />;

  if (!data) return <LoadError title="Background jobs could not be loaded." query={jobs} />;

  const runError = (
    <MutationError
      error={run.error}
      message={`${run.variables ?? 'The job'} could not be started.`}
      className="mb-3"
    />
  );

  if (runs.length === 0) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        No maintenance has run yet. Jobs start on their own schedule after the API boots.
      </p>
    );
  }

  return (
    <div>
      {runError}
      <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
        {runs.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-3 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
          >
            {entry.status === 'error' ? (
              <AlertTriangle className="size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">{entry.jobName}</p>
              <p className="truncate text-[var(--text-muted)] text-xs">
                {new Date(entry.startedAt).toLocaleString()} · {entry.itemsProcessed} item
                {entry.itemsProcessed === 1 ? '' : 's'}
                {entry.errorMessage ? ` · ${entry.errorMessage}` : ''}
              </p>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Run ${entry.jobName} now`}
              disabled={run.isPending}
              onClick={() => run.mutate(entry.jobName)}
            >
              <RefreshCw />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StorageReconcile() {
  const [report, setReport] = useState<ReconcileReport | null>(null);

  const reconcile = useMutation({
    mutationFn: (deleteOrphans: boolean) =>
      api.post<ReconcileReport>(
        `/admin/lifecycle/storage-reconcile${deleteOrphans ? '?deleteOrphans=true' : ''}`,
      ),
    onSuccess: setReport,
  });

  return (
    <div className="flex flex-col gap-4">
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

export function AdminMaintenancePage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminPageHeader
        title="Maintenance"
        description="Background cleanup and storage integrity. Jobs hold a lock while running, so each one runs on a single replica at a time even when several are deployed."
      />

      <div className="flex flex-col gap-10 pb-10">
        <SettingsSection
          title="Background jobs"
          description="The most recent run of each scheduled job, and a way to run one immediately."
        >
          <JobHealth />
        </SettingsSection>

        <SettingsSection
          title="Storage reconciliation"
          description="Compares object storage against the database in both directions to find files with no record and records with no file."
        >
          <StorageReconcile />
        </SettingsSection>
      </div>
    </div>
  );
}
