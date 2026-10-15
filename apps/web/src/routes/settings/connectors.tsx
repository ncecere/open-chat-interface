import type { UserConnector } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { CheckCircle2, Plug } from 'lucide-react';
import { LoadError } from '~/components/settings/load-error';
import { tWithUserText } from '~/components/settings/user-text';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import {
  CONNECT_OUTCOME_KEYS,
  fetchUserConnectors,
  startConnecting,
  USER_CONNECTORS_QUERY_KEY,
} from '~/lib/connectors';
import { useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';

function ConnectorRow({ connector }: { connector: UserConnector }) {
  const t = useT();
  const queryClient = useQueryClient();
  // Connecting and disconnecting are refused while read-only (#353).
  const lock = useReadOnlyLock();
  const connect = useMutation({ mutationFn: () => startConnecting(connector.id, 'settings') });
  const disconnect = useMutation({
    mutationFn: () => api.delete(`/connectors/${connector.id}/account`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USER_CONNECTORS_QUERY_KEY }),
  });
  const error = connect.error ?? disconnect.error;
  const status = connector.connected
    ? t('settings.connectors.connected')
    : connector.needsReconnect
      ? t('settings.connectors.expired')
      : t('settings.connectors.notConnected');
  return (
    <li
      className="flex flex-col gap-3 border-b border-[var(--border-subtle)] py-4 last:border-0 sm:flex-row sm:items-center"
      data-testid="user-connector"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-[var(--text-primary)]">{connector.name}</p>
          <Badge
            variant={
              connector.connected ? 'success' : connector.needsReconnect ? 'warning' : 'neutral'
            }
          >
            {status}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {connector.connected
            ? t('settings.connectors.connectedPrompt', { count: connector.toolCount })
            : tWithUserText(
                t,
                'settings.connectors.connectPrompt',
                { name: connector.name, count: connector.toolCount },
                ['name'],
              )}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-sm text-[var(--danger)]">
            {error instanceof ApiError ? error.message : t('settings.connectors.wentWrong')}
          </p>
        )}
      </div>
      {connector.connected ? (
        <Button
          variant="secondary"
          size="sm"
          locked={lock.title}
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
          aria-label={t('settings.connectors.disconnectLabel', { name: connector.name })}
        >
          {disconnect.isPending && <Spinner />}
          {t('settings.connectors.disconnect')}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          locked={lock.title}
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
          aria-label={t('settings.connectors.connectLabel', { name: connector.name })}
        >
          {connect.isPending && <Spinner />}
          {connector.needsReconnect
            ? t('settings.connectors.reconnect')
            : t('settings.connectors.connect')}
        </Button>
      )}
    </li>
  );
}

/**
 * Settings → Connectors: the services a person signs in to so models can use
 * their tools with the person's own account and permissions.
 */
export function SettingsConnectorsPage() {
  const t = useT();
  const search = useSearch({ strict: false }) as { connected?: string; error?: string };
  const connectors = useQuery({
    queryKey: USER_CONNECTORS_QUERY_KEY,
    queryFn: fetchUserConnectors,
  });
  const list = connectors.data?.connectors ?? [];
  const justConnected = search.connected
    ? list.find((connector) => connector.slug === search.connected)
    : undefined;

  return (
    <div>
      <h1 className="text-2xl font-bold">{t('settings.connectors.title')}</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
        {t('settings.connectors.description')}
      </p>

      <div aria-live="polite" className="mt-4">
        {justConnected && (
          <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {tWithUserText(t, 'settings.connectors.isConnected', { name: justConnected.name }, [
              'name',
            ])}
          </p>
        )}
        {search.error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {t(CONNECT_OUTCOME_KEYS[search.error] ?? 'settings.connectors.outcomeFailed')}
          </p>
        )}
      </div>

      {connectors.isLoading ? (
        <div className="py-16" role="status" aria-label={t('settings.connectors.loading')}>
          <Spinner className="mx-auto size-6" />
        </div>
      ) : connectors.isError ? (
        // Announced, with Try again, as every list's load error (#245).
        <LoadError title={t('settings.connectors.loadError')} query={connectors} className="mt-8" />
      ) : list.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <Plug className="size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm text-[var(--text-muted)]">{t('settings.connectors.empty')}</p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col">
          {list.map((connector) => (
            <ConnectorRow key={connector.id} connector={connector} />
          ))}
        </ul>
      )}
    </div>
  );
}
