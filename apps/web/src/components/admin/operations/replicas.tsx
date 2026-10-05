import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from '~/components/admin/admin-ui';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';

/**
 * The API replicas heard from in the last minute and their roles (v0.11,
 * OCI_ROLE). A deployment whose replicas all run `web` runs no background
 * jobs; the "Background workers" health check reports that as an error, and
 * this list shows which replicas are there.
 */

type ProcessRole = 'web' | 'worker' | 'all';

export interface ReplicaInfo {
  id: string;
  role: ProcessRole;
  host: string;
  version: string;
  startedAt: string;
  seenAt: string;
}

/** The part of GET /admin/health this reads. Absent from servers before v0.11. */
interface ReplicasHealth {
  replicas?: { role: ProcessRole; live: ReplicaInfo[] | null };
}

const ROLE_LABELS: Record<ProcessRole, string> = {
  web: 'Web (API only)',
  worker: 'Worker (background jobs)',
  all: 'API and background jobs',
};

/** The System health section; nothing on a server too old to report replicas. */
export function Replicas() {
  // Shares the health checks' query (same key), so this costs no request.
  const health = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => api.get<ReplicasHealth>('/admin/health'),
    refetchInterval: 30_000,
  });
  const replicas = health.data?.replicas;
  if (!replicas) return null;
  return (
    <SettingsSection
      editable={false}
      title="Replicas"
      description="API replicas heard from in the last minute, and whether each serves requests, runs background jobs, or both (OCI_ROLE)."
    >
      <ReplicaList replicas={replicas} />
    </SettingsSection>
  );
}

function ReplicaList({ replicas }: { replicas: NonNullable<ReplicasHealth['replicas']> }) {
  if (!replicas.live) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        This replica runs as {ROLE_LABELS[replicas.role].toLowerCase()}. Other replicas are listed
        only when Redis is configured.
      </p>
    );
  }
  if (replicas.live.length === 0) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        No replica has checked in during the last minute.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {replicas.live.map((replica) => (
        <li key={replica.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{replica.host}</p>
            <p className="text-[var(--text-muted)] text-xs">
              {ROLE_LABELS[replica.role]} · v{replica.version} · started{' '}
              {formatRelativeTime(replica.startedAt)}
            </p>
          </div>
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">
            Seen {formatRelativeTime(replica.seenAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
