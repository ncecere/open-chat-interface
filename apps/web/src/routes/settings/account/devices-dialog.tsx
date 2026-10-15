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
import { formatRelativeTime, translate, useT } from '~/lib/i18n';
import { describeUserAgent } from '~/lib/user-agent';
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
  const t = useT();
  const name = describeUserAgent(session.userAgent);
  return (
    <li
      className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0"
      data-testid="account-session"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-primary)]">
          {name}
          {session.current && <Badge variant="success">{t('settings.devices.thisDevice')}</Badge>}
          {session.impersonated && (
            <Badge variant="warning">{t('settings.devices.adminSession')}</Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {session.ipAddress ? `${session.ipAddress} · ` : ''}
          {t('settings.devices.signedIn', { when: formatRelativeTime(session.createdAt) })} ·{' '}
          {/* The device you are reading this on is in use now; the server
              records activity in five-minute steps (#98). */}
          {session.current
            ? t('settings.devices.activeNow')
            : t('settings.devices.lastActive', { when: formatRelativeTime(session.lastActiveAt) })}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          aria-label={t('settings.devices.signOutLabel', {
            name,
            when: formatRelativeTime(session.createdAt),
          })}
          onClick={onSignOut}
        >
          {t('settings.devices.signOut')}
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
  const t = useT();
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
      setMessage(translate('settings.devices.signedOutOne'));
      return refresh();
    },
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/me/sessions/revoke-others'),
    onSuccess: (result) => {
      setMessage(translate('settings.devices.signedOutOthers', { count: result.revoked }));
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
          <DialogTitle>{t('settings.devices.title')}</DialogTitle>
          <DialogDescription>
            {/* Sessions are read from the database on every request (no
                cookie cache since v0.11), so signing out applies at once (#235). */}
            {t('settings.devices.description')}
          </DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <div className="py-8" role="status" aria-label={t('settings.devices.loading')}>
            <Spinner className="mx-auto size-6" />
          </div>
        ) : sessions.isError ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {t('settings.devices.loadFailed')}
          </p>
        ) : (
          <ul
            aria-label={t('settings.devices.list')}
            className="flex max-h-[50vh] flex-col overflow-y-auto"
          >
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
            {apiErrorMessage(error, t('settings.devices.failed'))}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={others === 0 || signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
          >
            {signOutOthers.isPending && <Spinner />}
            {t('settings.devices.signOutOthers')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
