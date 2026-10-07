import type { AccountSession } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { describeUserAgent } from '~/lib/user-agent';
import { formatRelativeTime } from '~/lib/utils';
import { SESSIONS_KEY } from './account-helpers';

function SessionRow({
  session,
  onSignOut,
  pending,
}: {
  session: AccountSession;
  onSignOut: () => void;
  pending: boolean;
}) {
  const name = describeUserAgent(session.userAgent);
  return (
    <li
      className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0"
      data-testid="account-session"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-primary)]">
          {name}
          {session.current && <Badge variant="success">This device</Badge>}
          {session.impersonated && <Badge variant="warning">Administrator session</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {session.ipAddress ? `${session.ipAddress} · ` : ''}Signed in{' '}
          {formatRelativeTime(session.createdAt)} ·{' '}
          {/* The device you are reading this on is in use now; the server
              records activity in five-minute steps (#98). */}
          {session.current
            ? 'Active now'
            : `Last active ${formatRelativeTime(session.lastActiveAt)}`}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          aria-label={`Sign out ${name}, signed in ${formatRelativeTime(session.createdAt)}`}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

export function DevicesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api.get<{ sessions: AccountSession[] }>('/me/sessions'),
    select: (data) => data.sessions,
    enabled: open,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

  const signOutOne = useMutation({
    mutationFn: (id: string) => api.delete(`/me/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setMessage('That device has been signed out.');
      return refresh();
    },
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/me/sessions/revoke-others'),
    onSuccess: (result) => {
      setMessage(
        result.revoked === 1
          ? '1 other device has been signed out.'
          : `${result.revoked} other devices have been signed out.`,
      );
      return refresh();
    },
  });
  const error = signOutOne.error ?? signOutOthers.error;
  const list = sessions.data ?? [];
  const others = list.filter((session) => !session.current).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setMessage('');
          signOutOne.reset();
          signOutOthers.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Devices</DialogTitle>
          <DialogDescription>
            {/* Sessions are read from the database on every request (no
                cookie cache since v0.11), so signing out applies at once (#235). */}
            Where your account is signed in. A device you sign out is signed out at once; a page
            still open there goes to the sign-in page when it next contacts the server.
          </DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <div className="py-8" role="status" aria-label="Loading devices">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : sessions.isError ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            Your devices could not be loaded. Try again.
          </p>
        ) : (
          <ul aria-label="Signed-in devices" className="flex max-h-[50vh] flex-col overflow-y-auto">
            {list.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                pending={signOutOne.isPending && signOutOne.variables === session.id}
                onSignOut={() => signOutOne.mutate(session.id)}
              />
            ))}
          </ul>
        )}
        <p role="status" aria-live="polite" className="mt-2 text-xs text-[var(--text-muted)]">
          {message}
        </p>
        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {apiErrorMessage(error, 'That could not be done. Try again.')}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={others === 0 || signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
          >
            {signOutOthers.isPending && <Spinner />}
            Sign out all other devices
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
