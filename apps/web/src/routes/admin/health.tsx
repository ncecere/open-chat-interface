import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { AdminPageHeader, LoadError } from '~/components/admin/admin-ui';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { cn, formatRelativeTime } from '~/lib/utils';

type Status = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

interface JobRun {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  itemsProcessed: number;
  errorMessage: string | null;
}

interface HealthResponse {
  status: Status;
  checks: Check[];
  recentJobs: JobRun[];
}

const STATUS_STYLES: Record<Status, { icon: typeof CircleCheck; className: string }> = {
  ok: { icon: CircleCheck, className: 'text-[var(--success)]' },
  warn: { icon: TriangleAlert, className: 'text-[var(--warning)]' },
  error: { icon: CircleAlert, className: 'text-[var(--danger)]' },
};

const SUMMARY: Record<Status, string> = {
  ok: 'Everything is responding normally.',
  warn: 'Working, with something worth looking at.',
  error: 'Something is broken and users are affected.',
};

export function AdminHealthPage() {
  const health = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api.get<HealthResponse>('/admin/health'),
    // Stale quickly: this page is opened precisely when something is suspected
    // to be wrong, and a cached green summary would be actively misleading.
    refetchInterval: 30_000,
  });
  const { data, isLoading } = health;

  if (isLoading) return <FullPageSpinner />;

  if (!data) {
    return (
      <div>
        <AdminPageHeader
          title="Health"
          description="Whether the parts this instance depends on are working."
        />
        <LoadError title="Health checks could not be loaded." query={health} />
      </div>
    );
  }

  const Overall = STATUS_STYLES[data.status].icon;

  return (
    <div>
      <AdminPageHeader
        title="Health"
        description="Whether the parts this instance depends on are working."
      />

      <div className="flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
        <Overall className={cn('size-5 shrink-0', STATUS_STYLES[data.status].className)} />
        <p className="font-medium text-sm">{SUMMARY[data.status]}</p>
      </div>

      <ul className="mt-6 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
        {data.checks.map((check) => {
          const Icon = STATUS_STYLES[check.status].icon;
          return (
            <li key={check.id} className="flex items-start gap-3 px-4 py-3">
              <Icon
                className={cn('mt-0.5 size-4 shrink-0', STATUS_STYLES[check.status].className)}
                aria-label={check.status}
              />
              <div className="min-w-0">
                <p className="font-medium text-sm">{check.label}</p>
                <p className="text-[var(--text-muted)] text-xs">{check.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="mt-8">
        <h2 className="font-semibold text-base">Recent background jobs</h2>
        {data.recentJobs.length === 0 ? (
          <p className="mt-3 text-[var(--text-muted)] text-sm">No jobs have run yet.</p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-control-alt)] text-[var(--text-muted)] text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Job</th>
                  <th className="px-4 py-2 text-left">Started</th>
                  <th className="px-4 py-2 text-left">Duration</th>
                  <th className="px-4 py-2 text-left">Items</th>
                  <th className="px-4 py-2 text-left">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJobs.map((job) => (
                  <tr key={job.id} className="border-[var(--border-subtle)] border-t">
                    <td className="px-4 py-2 font-mono text-xs">{job.jobName}</td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">
                      {formatRelativeTime(job.startedAt)}
                    </td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">
                      {job.durationMs === null ? '—' : `${job.durationMs} ms`}
                    </td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">{job.itemsProcessed}</td>
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          'text-xs',
                          job.status === 'error'
                            ? 'text-[var(--danger)]'
                            : job.status === 'running'
                              ? 'text-[var(--warning)]'
                              : 'text-[var(--text-muted)]',
                        )}
                      >
                        {job.errorMessage ?? job.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
