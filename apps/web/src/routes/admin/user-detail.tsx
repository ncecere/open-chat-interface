import type { AdminUser } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatBytes, formatRelativeTime, formatTimeUntil } from '~/lib/utils';

interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

interface ThreadRow {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  targetType: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface UserDetail {
  user: AdminUser;
  storage: { bytesUsed: number; fileCount: number };
  sessions: SessionRow[];
  recentThreads: ThreadRow[];
  audit: AuditRow[];
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-[var(--border-subtle)] border-r px-4 py-3 last:border-r-0">
      <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide">{label}</p>
      <p className="mt-1 font-semibold text-lg">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-semibold text-base">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[var(--text-muted)] text-sm">{children}</p>;
}

/**
 * One account, with what an administrator actually asks about it.
 *
 * The listing answers "who exists"; this answers "what has this person been
 * doing, and why are they hitting a limit" — which previously required reading
 * the database directly.
 */
export function AdminUserDetailPage() {
  const { userId } = useParams({ strict: false }) as { userId: string };
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', userId],
    queryFn: () => api.get<UserDetail>(`/admin/users/${userId}`),
  });

  const revokeSessions = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/revoke-sessions`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
  });

  if (isLoading || !data) return <FullPageSpinner />;

  const { user, storage, sessions, recentThreads, audit } = data;

  return (
    <div>
      <Link
        to="/admin/users"
        className="inline-flex items-center gap-1.5 text-[var(--text-muted)] text-sm hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="size-4" />
        All users
      </Link>

      <AdminPageHeader title={user.name || user.email} description={user.email} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
        {user.banned && <Badge variant="danger">banned</Badge>}
        {!user.emailVerified && <Badge variant="neutral">unverified</Badge>}
      </div>

      <div className="mt-6 grid grid-cols-2 rounded-xl border border-[var(--border-subtle)] sm:grid-cols-4">
        <Stat label="Threads" value={String(user.threadCount)} />
        <Stat label="Messages" value={String(user.messageCount)} />
        <Stat label="Storage" value={formatBytes(storage.bytesUsed)} />
        <Stat label="Files" value={String(storage.fileCount)} />
      </div>

      <Section title="Active sessions">
        {sessions.length === 0 ? (
          <Empty>No active sessions.</Empty>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--bg-control-alt)] text-[var(--text-muted)] text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Started</th>
                    <th className="px-4 py-2 text-left">Expires</th>
                    <th className="px-4 py-2 text-left">Address</th>
                    <th className="px-4 py-2 text-left">Client</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id} className="border-[var(--border-subtle)] border-t">
                      <td className="px-4 py-2">{formatRelativeTime(session.createdAt)}</td>
                      <td className="px-4 py-2 text-[var(--text-muted)]">
                        {formatTimeUntil(session.expiresAt)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{session.ipAddress ?? '—'}</td>
                      <td className="max-w-xs truncate px-4 py-2 text-[var(--text-muted)] text-xs">
                        {session.userAgent ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={revokeSessions.isPending}
              onClick={() => revokeSessions.mutate()}
            >
              Sign out everywhere
            </Button>
          </>
        )}
      </Section>

      <Section title="Recent conversations">
        {recentThreads.length === 0 ? (
          <Empty>No conversations.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {recentThreads.map((thread) => (
              <li key={thread.id} className="flex items-center justify-between px-4 py-2.5">
                {/* Titles only. An administrator managing an account has no
                    reason to read its contents, and this page should not be
                    the thing that makes that easy. */}
                <span className="truncate text-sm">{thread.title || 'Untitled'}</span>
                <span className="shrink-0 text-[var(--text-muted)] text-xs">
                  {formatRelativeTime(thread.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent activity">
        {/* The panel shows the last twenty-five; the log holds the rest. */}
        <p className="mb-3 text-xs">
          <Link
            to="/admin/audit"
            search={{ search: user.email }}
            className="text-[var(--accent-bright)] hover:underline"
          >
            See every event for this account
          </Link>
        </p>
        {audit.length === 0 ? (
          <Empty>No recorded events.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {audit.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                <code className="rounded bg-[var(--bg-control-alt)] px-1.5 py-0.5 text-xs">
                  {entry.action}
                </code>
                {entry.ipAddress && (
                  <span className="font-mono text-[var(--text-muted)] text-xs">
                    {entry.ipAddress}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[var(--text-muted)] text-xs">
                  {formatRelativeTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
