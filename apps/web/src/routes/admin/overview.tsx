import type { AdminOverview } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatBytes } from '~/lib/utils';

function StatCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {title}
        </p>
        <p className="mt-2 text-2xl font-semibold">{value}</p>
        {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
      </CardContent>
    </Card>
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
      <h1 className="text-2xl font-bold">Overview</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Instance health and activity at a glance.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Users"
          value={String(data.users.total)}
          hint={`${data.users.admins} admin${data.users.admins === 1 ? '' : 's'}`}
        />
        <StatCard
          title="Threads"
          value={String(data.threads.total)}
          hint={`${data.threads.last24h} in last 24h`}
        />
        <StatCard
          title="Messages"
          value={String(data.messages.total)}
          hint={`${data.messages.last24h} in last 24h`}
        />
        <StatCard
          title="Storage"
          value={formatBytes(data.storage.totalBytes)}
          hint={`${data.storage.fileCount} file${data.storage.fileCount === 1 ? '' : 's'}`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
