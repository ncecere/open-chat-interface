import type { WebhookEndpoint, WebhookWithSecret } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useEditedSince } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type FieldProblem,
  linkFields,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';
import {
  type Draft,
  parseActions,
  unmatchedActions,
  WEBHOOKS_QUERY_KEY,
  webhookChanges,
} from './webhook-helpers';

/** The fields that show their own errors; any other is shown at the foot (#283). */
const FIELDS_SHOWN = ['url', 'description', 'actions'];

/**
 * A plain http:// URL is refused only while "Allow private network" is off,
 * so switching it on clears the complaint, as correcting the URL does (#283).
 * Sending every event answers "choose at least one action".
 */
const LINKED_FIELDS = { url: ['allowPrivateNetwork'], actions: ['allActions'] };

/** The form's names for the fields, so each error names the one it is about (#127, #283). */
const WEBHOOK_LABELS = { url: 'URL', description: 'Description', actions: 'Audit actions' };

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
  // Each error is shown under its field, marked invalid, all at once, and
  // goes when that field is corrected (#217, #283).
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems(draft, form);
  // Escape or a click outside asks before throwing edits away (#45, #300).
  const edited = useEditedSince(draft);
  const report = (found: FieldProblem[]) => setProblems(linkFields(found, LINKED_FIELDS));
  const at = (field: keyof Draft) => problemsAt(problems, field);
  const error = problemsElsewhere(problems, FIELDS_SHOWN);
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
    onError: (cause) =>
      report(apiErrorProblems(cause, 'The endpoint could not be saved.', WEBHOOK_LABELS)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);
    // No check of its own first: the API reports a missing URL or action
    // list together with the URL's network rule, which only it can check.
    // Stopping at the form's own check left that one for the next save (#301).
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
    <DialogContent className="max-h-[90dvh] overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{endpoint ? 'Edit webhook endpoint' : 'Add webhook endpoint'}</DialogTitle>
        <DialogDescription>
          OCI posts the selected audit events here, signed with a secret only this endpoint knows.
        </DialogDescription>
      </DialogHeader>
      <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="URL"
          htmlFor="webhook-url"
          hint="An https:// address. Redirects are not followed."
          error={at('url')}
        >
          <Input
            id="webhook-url"
            {...invalidFieldProps('webhook-url', at('url'))}
            value={draft.url}
            placeholder="https://hooks.example.com/oci"
            onChange={(event) => set('url', event.target.value)}
          />
        </Field>
        <Field
          label="Description (optional)"
          htmlFor="webhook-description"
          error={at('description')}
        >
          <Input
            id="webhook-description"
            {...invalidFieldProps('webhook-description', at('description'))}
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
            error={at('actions')}
            hint="One per line. A prefix such as user.* matches every action below it."
          >
            <Textarea
              id="webhook-actions"
              {...invalidFieldProps(
                'webhook-actions',
                at('actions'),
                unmatched.length > 0 ? 'webhook-actions-unmatched' : undefined,
              )}
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
          <p role="alert" className="whitespace-pre-line text-sm text-[var(--danger)]">
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
