import type { AdminUser } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Scale } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, LoadError, MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { DeleteUserSection } from '~/components/admin/delete-user';
import { UserLimitsSection } from '~/components/admin/user-limits';
import {
  ADMIN_USERS_QUERY_KEY,
  ROLE_LABELS,
  UserRoleSelect,
} from '~/components/admin/user-role-select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
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
  /** Null (or absent, before v0.9) when the person is not on legal hold. */
  legalHold?: { reason: string; placedAt: string; placedByEmail: string | null } | null;
  storage: { bytesUsed: number; fileCount: number };
  sessions: SessionRow[];
  recentThreads: ThreadRow[];
  audit: AuditRow[];
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
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

  const detail = useQuery({
    queryKey: ['admin', 'users', userId],
    queryFn: () => api.get<UserDetail>(`/admin/users/${userId}`),
  });
  const { data, isLoading } = detail;

  const [confirming, setConfirming] = useState<'ban' | 'sign-out' | null>(null);
  const [banReason, setBanReason] = useState('');

  // The prefix covers this page, its limits and the account listing.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });

  async function banAccount() {
    // The server ends the account's sessions as part of the ban.
    await api.patch(`/admin/users/${userId}`, {
      banned: true,
      banReason: banReason.trim() || null,
    });
    await invalidate();
  }

  async function signOutEverywhere() {
    await api.post(`/admin/users/${userId}/revoke-sessions`, {});
    await invalidate();
  }

  const unban = useMutation({
    mutationFn: () => api.patch(`/admin/users/${userId}`, { banned: false, banReason: null }),
    onSuccess: invalidate,
  });

  if (isLoading) return <FullPageSpinner />;

  if (!data) {
    return (
      <div>
        <Link
          to="/admin/users"
          className="inline-flex items-center gap-1.5 text-[var(--text-muted)] text-sm hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="size-4" />
          All users
        </Link>
        <LoadError title="This account could not be loaded." query={detail} className="mt-6" />
      </div>
    );
  }

  const { user, storage, sessions, recentThreads, audit } = data;
  const name = user.name || user.email;
  const sessionCount = `${sessions.length} active session${sessions.length === 1 ? '' : 's'}`;

  return (
    <div>
      <Link
        to="/admin/users"
        className="inline-flex items-center gap-1.5 text-[var(--text-muted)] text-sm hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="size-4" />
        All users
      </Link>

      <AdminPageHeader
        title={name}
        description={user.email}
        actions={
          <EditOnly>
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <UserRoleSelect user={user} />
              {user.banned ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={unban.isPending}
                  onClick={() => unban.mutate()}
                >
                  Unban
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setBanReason('');
                    setConfirming('ban');
                  }}
                >
                  Ban
                </Button>
              )}
              {sessions.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirming('sign-out')}
                >
                  Sign out everywhere
                </Button>
              )}
              <MutationError
                error={unban.error}
                message="The ban could not be lifted."
                className="basis-full"
              />
            </div>
          </EditOnly>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={user.role === 'admin' ? 'accent' : 'neutral'}>
          {ROLE_LABELS[user.role]}
        </Badge>
        {user.banned && <Badge variant="danger">Banned</Badge>}
        {user.legalHold && <Badge variant="warning">Legal hold</Badge>}
        {!user.emailVerified && <Badge variant="neutral">Unverified</Badge>}
      </div>

      {user.banned && (
        <div className="mt-4 flex gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm">
          <Ban className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-[var(--text-primary)]">This account is banned</p>
            <p className="mt-1 break-words text-[var(--text-muted)]">
              {user.banReason ? `Reason: ${user.banReason}` : 'No reason was recorded.'} They cannot
              sign in until the ban is lifted.
            </p>
          </div>
        </div>
      )}

      {data.legalHold && (
        <div className="mt-4 flex gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm">
          <Scale className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-[var(--text-primary)]">This person is on legal hold</p>
            <p className="mt-1 break-words text-[var(--text-muted)]">
              Reason: {data.legalHold.reason}. Placed {formatRelativeTime(data.legalHold.placedAt)}
              {data.legalHold.placedByEmail ? ` by ${data.legalHold.placedByEmail}` : ''}.
              Retention, trash purging, temporary chat expiry and account deletion skip their data
              until the hold is lifted under{' '}
              <Link to="/admin/compliance" className="text-[var(--accent-bright)] hover:underline">
                Compliance
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      {/* Borders are drawn per cell so the rules stay right when the four
          figures wrap into two rows on a phone. */}
      <div className="mt-6 grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] sm:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t sm:[&>*:nth-child(n+2)]:border-l sm:[&>*:nth-child(n+3)]:border-t-0">
        <Stat label="Threads" value={String(user.threadCount)} />
        <Stat label="Messages" value={String(user.messageCount)} />
        <Stat label="Storage" value={formatBytes(storage.bytesUsed)} />
        <Stat label="Files" value={String(storage.fileCount)} />
      </div>

      <Section title="Active sessions">
        {sessions.length === 0 ? (
          <Empty>No active sessions.</Empty>
        ) : (
          <section
            // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
            tabIndex={0}
            aria-label="Active sessions"
            className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
          >
            <table className="w-full min-w-[32rem] text-sm">
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
          </section>
        )}
      </Section>

      <UserLimitsSection user={user} />

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
            // By id, as actor or target, so actions taken *on* this account
            // are included (they carry the admin's email, not this one).
            search={{ user: user.id, userEmail: user.email }}
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

      <DeleteUserSection user={{ ...user, legalHold: Boolean(user.legalHold || data.legalHold) }} />

      <ConfirmDialog
        open={confirming === 'ban'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Ban ${name}?`}
        description={`${name} will be signed out of every session straight away and cannot sign in again until an administrator lifts the ban.`}
        confirmLabel="Ban account"
        pendingLabel="Banning…"
        errorMessage="The account could not be banned."
        onConfirm={banAccount}
      >
        <Field
          label="Reason (optional)"
          htmlFor="ban-reason"
          hint="Shown to administrators on this account."
        >
          <Input
            id="ban-reason"
            value={banReason}
            maxLength={500}
            onChange={(event) => setBanReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'sign-out'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Sign ${name} out everywhere?`}
        description={`This ends ${sessionCount}. ${name} can sign in again straight away.`}
        confirmLabel="End all sessions"
        pendingLabel="Signing out…"
        errorMessage="Sessions could not be revoked."
        onConfirm={signOutEverywhere}
      />
    </div>
  );
}
