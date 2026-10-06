import type { WebhookEndpoint, WebhookWithSecret } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
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
import { api, apiErrorMessage } from '~/lib/api-client';
import {
  type Draft,
  parseActions,
  unmatchedActions,
  WEBHOOKS_QUERY_KEY,
  webhookChanges,
} from './webhook-helpers';

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

export function WebhookFormDialog({
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
  // A name that can never match was accepted silently (#83). Only a warning:
  // the list is what this instance has recorded, and an action may not have
  // happened yet.
  const unmatched =
    draft.allActions || knownActions.length === 0
      ? []
      : unmatchedActions(parseActions(draft.actions), knownActions);
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
    onError: (cause) => setError(apiErrorMessage(cause, 'The endpoint could not be saved.')),
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
              aria-describedby={unmatched.length > 0 ? 'webhook-actions-unmatched' : undefined}
              rows={5}
              value={draft.actions}
              placeholder={'user.*\nbackup.run'}
              onChange={(event) => set('actions', event.target.value)}
            />
          </Field>
        )}
        {unmatched.length > 0 && (
          <p id="webhook-actions-unmatched" role="status" className="text-xs text-[var(--warning)]">
            Nothing recorded so far matches {unmatched.join(', ')}. Check the spelling; it is saved
            anyway, in case the action has simply not happened yet.
          </p>
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
