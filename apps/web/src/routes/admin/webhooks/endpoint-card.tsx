import type { WebhookEndpoint, WebhookWithSecret } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { DeliveryLog } from './delivery-log';
import { WEBHOOKS_QUERY_KEY, when } from './webhook-helpers';

export function EndpointCard({
  endpoint,
  onEdit,
  onDelete,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  onEdit: () => void;
  onDelete: () => void;
  onSecret: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; status: number | null; error: string | null }>(
        `/admin/webhooks/${endpoint.id}/test`,
      ),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api.post<WebhookWithSecret>(`/admin/webhooks/${endpoint.id}/rotate`),
    onSuccess: async (result) => {
      onSecret(result.secret);
      await refresh();
    },
  });
  const [confirmRotate, setConfirmRotate] = useState(false);
  const headingId = `webhook-${endpoint.id}-heading`;
  const failing =
    endpoint.lastFailureAt &&
    (!endpoint.lastSuccessAt || endpoint.lastFailureAt > endpoint.lastSuccessAt);

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-[var(--border-subtle)] p-4"
      data-testid="webhook"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="truncate font-semibold">
              {endpoint.description || endpoint.url}
            </h2>
            {!endpoint.enabled && <Badge variant="warning">disabled</Badge>}
            {endpoint.allowPrivateNetwork && (
              <Badge variant="outline">private network allowed</Badge>
            )}
            <Badge variant="neutral">
              {endpoint.allActions
                ? 'All audit events'
                : `${endpoint.actions.length} action${endpoint.actions.length === 1 ? '' : 's'}`}
            </Badge>
          </div>
          {endpoint.description && (
            <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{endpoint.url}</p>
          )}
          {!endpoint.allActions && (
            <p className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">
              {endpoint.actions.join(', ')}
            </p>
          )}
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {endpoint.lastSuccessAt
              ? `Last delivered ${when(endpoint.lastSuccessAt)}`
              : 'Nothing delivered yet'}
            {` · ${endpoint.pendingDeliveries} pending`}
            {` · secret set ${when(endpoint.secretRotatedAt)}`}
            {failing && (
              <span className="text-[var(--danger)]">
                {` · Last failure ${when(endpoint.lastFailureAt)}: ${endpoint.lastError}`}
              </span>
            )}
          </p>
        </div>
        <EditOnly>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? <Spinner /> : <Send />}
              Send test
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmRotate(true)}>
              <KeyRound />
              Rotate secret
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${endpoint.url}`}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${endpoint.url}`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </div>
        </EditOnly>
      </div>

      <div aria-live="polite" className="mt-2 text-sm">
        {test.data && (
          <p className={test.data.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
            {test.data.ok
              ? `Test delivered (HTTP ${test.data.status}).`
              : `Test failed. ${test.data.error ?? ''}`}
          </p>
        )}
      </div>
      <MutationError error={test.error} message="The test event could not be sent." />
      <MutationError error={rotate.error} message="The secret could not be rotated." />

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2"
        aria-expanded={showLog}
        onClick={() => setShowLog((value) => !value)}
      >
        {showLog ? 'Hide deliveries' : 'Show deliveries'}
      </Button>
      {showLog && (
        <div className="mt-2">
          <DeliveryLog endpoint={endpoint} />
        </div>
      )}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the signing secret?"
        description="Requests are signed with the new secret straight away, including retries of earlier events. Update the receiver as soon as you have it."
        confirmLabel="Rotate secret"
        pendingLabel="Rotating…"
        errorMessage="The secret could not be rotated."
        onConfirm={() => rotate.mutateAsync().then(() => undefined)}
      />
    </section>
  );
}
