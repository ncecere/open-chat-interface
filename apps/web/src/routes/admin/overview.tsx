import type { AdminOverview } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { AdminPageHeader, SettingsSection } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatBytes } from '~/lib/utils';

function Stat({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </p>
      <p className="mt-2 truncate text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

/**
 * A count against the same window before it.
 *
 * "15 in the last 24 hours" invites the question "up or down from what?", and
 * a total on its own cannot answer it.
 */
function Trend({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return <span className="text-[var(--text-muted)]">{current} in last 24h</span>;
  }

  const change = Math.round(((current - previous) / previous) * 100);
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;

  return (
    <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
      {current} in last 24h
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {/* Direction is not judged: fewer messages is not automatically bad, so
          this stays neutral rather than colouring a fall red. */}
      <span>{Math.abs(change)}%</span>
    </span>
  );
}

/**
 * Fourteen days of message volume as a shape.
 *
 * Drawn inline rather than pulling in a charting library: this shows whether
 * something changed, and anything more precise belongs on the usage page.
 */
function Sparkline({ points }: { points: { day: string; messages: number }[] }) {
  if (points.length < 2) return null;

  const peak = Math.max(...points.map((point) => point.messages), 1);
  const step = 100 / (points.length - 1);
  const path = points
    .map((point, index) => `${index * step},${30 - (point.messages / peak) * 28}`)
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-10 w-full text-[var(--accent-bright)]"
      role="img"
      aria-label={`Messages per day over the last ${points.length} days, peaking at ${peak}`}
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function AdminOverviewPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/admin/overview'),
  });

  if (isLoading || !data) return <FullPageSpinner />;

  return (
    <div>
      <AdminPageHeader title="Overview" description="Instance health and activity at a glance." />

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)] lg:grid-cols-4 lg:divide-y-0">
        <Stat
          title="Users"
          value={String(data.users.total)}
          hint={`${data.users.admins} admin${data.users.admins === 1 ? '' : 's'}`}
        />
        <div className="min-w-0 p-5">
          <p className="font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
            Threads
          </p>
          <p className="mt-2 truncate font-semibold text-2xl">{data.threads.total}</p>
          <p className="mt-1 truncate text-xs">
            <Trend current={data.threads.last24h} previous={data.threads.previous24h} />
          </p>
        </div>
        <div className="min-w-0 p-5">
          <p className="font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
            Messages
          </p>
          <p className="mt-2 truncate font-semibold text-2xl">{data.messages.total}</p>
          <p className="mt-1 truncate text-xs">
            <Trend current={data.messages.last24h} previous={data.messages.previous24h} />
          </p>
        </div>
        <Stat
          title="Storage"
          value={formatBytes(data.storage.totalBytes)}
          hint={`${data.storage.fileCount} file${data.storage.fileCount === 1 ? '' : 's'}`}
        />
      </div>

      {data.activity.length > 1 && (
        <section className="mt-6 rounded-xl border border-[var(--border-subtle)] p-5">
          <h2 className="font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
            Messages per day
          </h2>
          <div className="mt-3">
            <Sparkline points={data.activity} />
          </div>
          <p className="mt-1 flex justify-between text-[var(--text-muted)] text-xs">
            <span>{data.activity[0]?.day}</span>
            <span>{data.activity.at(-1)?.day}</span>
          </p>
        </section>
      )}

      <div className="mt-8 flex flex-col gap-8">
        <SettingsSection title="Models">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Providers configured</span>
              <span>{data.providers.configured}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Models in catalog</span>
              <span>{data.models.total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Models enabled</span>
              <span>{data.models.enabled}</span>
            </div>
            {data.models.enabled === 0 && (
              <p className="rounded-lg bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
                No models are available yet. Add a provider, then curate which models users can
                select.
              </p>
            )}
          </div>
        </SettingsSection>

        <SettingsSection title="System">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">Version</span>
              <span>{data.system.version}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">Database</span>
              <Badge variant={data.system.database === 'ok' ? 'success' : 'danger'}>
                {data.system.database}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">Redis</span>
              <Badge variant={data.system.redis === 'ok' ? 'success' : 'neutral'}>
                {data.system.redis}
              </Badge>
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
