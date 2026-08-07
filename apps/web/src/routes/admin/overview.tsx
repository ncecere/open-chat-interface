import type { AdminOverview } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
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
        <Stat
          title="Threads"
          value={String(data.threads.total)}
          hint={`${data.threads.last24h} in last 24h`}
        />
        <Stat
          title="Messages"
          value={String(data.messages.total)}
          hint={`${data.messages.last24h} in last 24h`}
        />
        <Stat
          title="Storage"
          value={formatBytes(data.storage.totalBytes)}
          hint={`${data.storage.fileCount} file${data.storage.fileCount === 1 ? '' : 's'}`}
        />
      </div>

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
