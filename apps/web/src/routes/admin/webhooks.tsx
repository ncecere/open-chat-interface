import type { WebhookDelivery, WebhookEndpoint, WebhookWithSecret } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Notice,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
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
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';

export const WEBHOOKS_QUERY_KEY = ['admin', 'webhooks'] as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

/** One action per line or comma; blanks dropped, duplicates removed. Exported for tests. */
export function parseActions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

interface Draft {
  url: string;
  description: string;
  allActions: boolean;
  actions: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
}

/** Only the fields that differ from the saved endpoint. Exported for tests. */
export function webhookChanges(saved: WebhookEndpoint, draft: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.url.trim() !== saved.url) patch.url = draft.url.trim();
  if (draft.description.trim() !== saved.description) patch.description = draft.description.trim();
  if (draft.allActions !== saved.allActions) patch.allActions = draft.allActions;
  const actions = parseActions(draft.actions);
  if (JSON.stringify([...actions].sort()) !== JSON.stringify([...saved.actions].sort()))
    patch.actions = actions;
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  if (draft.allowPrivateNetwork !== saved.allowPrivateNetwork)
    patch.allowPrivateNetwork = draft.allowPrivateNetwork;
  return patch;
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-hint`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function WebhookFormDialog({
  endpoint,
  knownActions,
  onClose,
  onCreated,
}: {
  endpoint: WebhookEndpoint | null;
  knownActions: string[];
  onClose: () => void;
  onCreated: (created: WebhookWithSecret) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    url: endpoint?.url ?? '',
    description: endpoint?.description ?? '',
    allActions: endpoint?.allActions ?? false,
    actions: endpoint?.actions.join('\n') ?? '',
    enabled: endpoint?.enabled ?? true,
    allowPrivateNetwork: endpoint?.allowPrivateNetwork ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      endpoint
        ? api.patch<WebhookEndpoint>(`/admin/webhooks/${endpoint.id}`, body)
        : api.post<WebhookWithSecret>('/admin/webhooks', body),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
      if (!endpoint) onCreated(result as WebhookWithSecret);
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'The endpoint could not be saved.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!draft.url.trim()) {
      setError('Enter the endpoint’s URL.');
      return;
    }
    if (!draft.allActions && parseActions(draft.actions).length === 0) {
      setError('Choose at least one audit action, or send all of them.');
      return;
    }
    if (endpoint) {
      const patch = webhookChanges(endpoint, draft);
      if (Object.keys(patch).length === 0) onClose();
      else save.mutate(patch);
      return;
    }
    save.mutate({
      url: draft.url.trim(),
      description: draft.description.trim(),
      allActions: draft.allActions,
      actions: parseActions(draft.actions),
      enabled: draft.enabled,
      allowPrivateNetwork: draft.allowPrivateNetwork,
    });
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{endpoint ? 'Edit webhook endpoint' : 'Add webhook endpoint'}</DialogTitle>
        <DialogDescription>
          OCI posts the selected audit events here, signed with a secret only this endpoint knows.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="URL"
          htmlFor="webhook-url"
          hint="An https:// address. Redirects are not followed."
        >
          <Input
            id="webhook-url"
            value={draft.url}
            placeholder="https://hooks.example.com/oci"
            onChange={(event) => set('url', event.target.value)}
          />
        </Field>
        <Field label="Description (optional)" htmlFor="webhook-description">
          <Input
            id="webhook-description"
            value={draft.description}
            maxLength={200}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
        <SwitchRow
          id="webhook-all-actions"
          label="Send every audit event"
          hint="Includes high-volume events such as tool.call."
          checked={draft.allActions}
          onChange={(value) => set('allActions', value)}
        />
        {!draft.allActions && (
          <Field
            label="Audit actions"
            htmlFor="webhook-actions"
            hint="One per line. A prefix such as user.* matches every action below it."
          >
            <Textarea
              id="webhook-actions"
              rows={5}
              value={draft.actions}
              placeholder={'user.*\nbackup.run'}
              onChange={(event) => set('actions', event.target.value)}
            />
          </Field>
        )}
        {!draft.allActions && knownActions.length > 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            Recorded so far: {knownActions.slice(0, 40).join(', ')}
            {knownActions.length > 40 ? '…' : ''}
          </p>
        )}
        <SwitchRow
          id="webhook-enabled"
          label="Enabled"
          hint="A disabled endpoint receives nothing; nothing is queued for it."
          checked={draft.enabled}
          onChange={(value) => set('enabled', value)}
        />
        <SwitchRow
          id="webhook-private"
          label="Allow private network"
          hint="Allows plain http:// and private, loopback and link-local addresses. Only for receivers on your own network."
          checked={draft.allowPrivateNetwork}
          onChange={(value) => set('allowPrivateNetwork', value)}
        />
        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {endpoint ? 'Save changes' : 'Add endpoint'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
      <DialogHeader>
        <DialogTitle>Signing secret</DialogTitle>
        <DialogDescription>
          Copy it into the receiver now. It is shown only this once; rotate it if it is lost.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <Input aria-label="Signing secret" readOnly value={secret} className="font-mono" />
        <Button
          type="button"
          variant="secondary"
          aria-label="Copy secret"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          <Copy />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Verify each request: HMAC-SHA256 of <code>timestamp.body</code> with this secret must equal
        the <code>v1=</code> value in <code>OCI-Webhook-Signature</code>.
      </p>
      <DialogFooter>
        <Button type="button" variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DeliveryLog({ endpoint }: { endpoint: WebhookEndpoint }) {
  const log = useQuery({
    queryKey: [...WEBHOOKS_QUERY_KEY, endpoint.id, 'deliveries'],
    queryFn: () =>
      api.get<{ deliveries: WebhookDelivery[] }>(`/admin/webhooks/${endpoint.id}/deliveries`),
  });
  if (log.isLoading)
    return (
      <div role="status" aria-label="Loading deliveries">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  if (!log.data) return <LoadError title="Deliveries could not be loaded." query={log} />;
  if (log.data.deliveries.length === 0)
    return <p className="text-sm text-[var(--text-muted)]">Nothing delivered yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Recent deliveries to {endpoint.url}</caption>
        <thead className="text-[var(--text-muted)]">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Event
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Attempts
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Last attempt
            </th>
            <th scope="col" className="py-1 font-medium">
              Result
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {log.data.deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td className="py-1.5 pr-3 font-mono">{delivery.event}</td>
              <td className="py-1.5 pr-3">
                <Badge
                  variant={
                    delivery.status === 'succeeded'
                      ? 'success'
                      : delivery.status === 'failed'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {delivery.status === 'pending' && delivery.attempts > 0
                    ? 'retrying'
                    : delivery.status}
                </Badge>
              </td>
              <td className="py-1.5 pr-3">
                {delivery.attempts} of {delivery.maxAttempts}
              </td>
              <td className="py-1.5 pr-3">
                {delivery.lastAttemptAt ? formatRelativeTime(delivery.lastAttemptAt) : '—'}
              </td>
              <td className="py-1.5">
                {delivery.lastError ??
                  (delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : '')}
                {delivery.status === 'pending' && delivery.nextAttemptAt
                  ? ` · next ${formatRelativeTime(delivery.nextAttemptAt)}`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointCard({
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

/**
 * Tools & integrations → Webhooks: HTTPS endpoints that receive selected
 * audit events, signed with HMAC-SHA256 and retried with backoff.
 */
export function AdminWebhooksPage() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ endpoint: WebhookEndpoint | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const webhooks = useQuery({
    queryKey: WEBHOOKS_QUERY_KEY,
    queryFn: () => api.get<{ webhooks: WebhookEndpoint[] }>('/admin/webhooks'),
  });
  const actions = useQuery({
    queryKey: ['admin', 'audit', 'actions'],
    queryFn: () => api.get<{ actions: string[] }>('/admin/audit/actions'),
  });

  async function remove(endpoint: WebhookEndpoint) {
    await api.delete(`/admin/webhooks/${endpoint.id}`);
    await queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
  }

  return (
    <div>
      <AdminPageHeader
        title="Webhooks"
        description="Send selected audit events to your own systems as they happen. Each request is signed with HMAC-SHA256 and retried with backoff; payloads carry the audit entry’s metadata, never conversation content."
        actions={
          <EditOnly>
            <Button variant="secondary" onClick={() => setFormFor({ endpoint: null })}>
              <Plus />
              Add endpoint
            </Button>
          </EditOnly>
        }
      />
      <div className="flex flex-col gap-4">
        {webhooks.isLoading ? (
          <div className="py-8" role="status" aria-label="Loading webhooks">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : webhooks.isError || !webhooks.data ? (
          <LoadError title="Webhooks could not be loaded." query={webhooks} />
        ) : webhooks.data.webhooks.length === 0 ? (
          <EmptyState icon={Webhook} title="No webhook endpoints yet.">
            Add an HTTPS endpoint and choose the audit actions it receives, such as user.* or
            backup.run.
          </EmptyState>
        ) : (
          webhooks.data.webhooks.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              onEdit={() => setFormFor({ endpoint })}
              onDelete={() => setDeleteFor(endpoint)}
              onSecret={setSecret}
            />
          ))
        )}
        <Notice title="Verifying requests">
          Each request carries <code>OCI-Webhook-Timestamp</code> and{' '}
          <code>OCI-Webhook-Signature: v1=&lt;hex&gt;</code>, the HMAC-SHA256 of{' '}
          <code>timestamp.body</code> with the endpoint’s secret. Reject requests whose timestamp is
          more than five minutes old, and deduplicate by the payload’s <code>id</code>.
        </Notice>
      </div>

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <WebhookFormDialog
            endpoint={formFor.endpoint}
            knownActions={actions.data?.actions ?? []}
            onClose={() => setFormFor(null)}
            onCreated={(created) => setSecret(created.secret)}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(secret)} onOpenChange={(open) => !open && setSecret(null)}>
        {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title="Delete this webhook endpoint?"
        description={
          deleteFor
            ? `${deleteFor.url} stops receiving events, and its delivery log and ${deleteFor.pendingDeliveries} pending deliver${deleteFor.pendingDeliveries === 1 ? 'y' : 'ies'} are removed. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete endpoint"
        pendingLabel="Deleting…"
        errorMessage="The endpoint could not be deleted."
        onConfirm={() => (deleteFor ? remove(deleteFor) : Promise.resolve())}
      />
    </div>
  );
}
