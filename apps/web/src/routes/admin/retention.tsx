import { MIN_TRASH_RETENTION_DAYS, type RetentionSettings } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EditableFieldset, EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, LoadError, Notice } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

function RetentionForm({ settings }: { settings: RetentionSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const save = useMutation({
    mutationFn: () => api.put<RetentionSettings>('/admin/lifecycle/retention', draft),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'retention'] });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'Retention could not be saved.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 pb-10">
      <EditableFieldset className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Trash retention (days)"
            htmlFor="trash-days"
            hint="How long a deleted conversation stays restorable before it is destroyed."
          >
            <Input
              id="trash-days"
              type="number"
              min={MIN_TRASH_RETENTION_DAYS}
              max="365"
              value={draft.trashRetentionDays}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  trashRetentionDays: Number(event.target.value),
                }))
              }
            />
          </Field>

          <Field
            label="Conversation retention (days)"
            htmlFor="thread-days"
            hint="Inactive conversations move to trash after this long. Leave blank to keep them forever."
          >
            <Input
              id="thread-days"
              type="number"
              min="1"
              placeholder="Never"
              value={draft.threadRetentionDays ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  threadRetentionDays: event.target.value ? Number(event.target.value) : null,
                }))
              }
            />
          </Field>

          <Field
            label="Usage history (days)"
            htmlFor="usage-days"
            hint="Per-message usage rows. Daily totals are kept regardless."
          >
            <Input
              id="usage-days"
              type="number"
              min="1"
              value={draft.usageEventRetentionDays}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  usageEventRetentionDays: Number(event.target.value),
                }))
              }
            />
          </Field>

          <Field
            label="Reporting timezone"
            htmlFor="display-timezone"
            hint="Where a day starts and ends on the Usage page. Limits reset on their own policy's timezone, which this does not change."
          >
            <Input
              id="display-timezone"
              value={draft.displayTimezone}
              placeholder="UTC"
              onChange={(event) =>
                setDraft((current) => ({ ...current, displayTimezone: event.target.value }))
              }
            />
          </Field>

          <Field
            label="Audit log (days)"
            htmlFor="audit-days"
            hint="Security-relevant entries such as role and credential changes are kept regardless."
          >
            <Input
              id="audit-days"
              type="number"
              min="1"
              value={draft.auditLogRetentionDays}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  auditLogRetentionDays: Number(event.target.value),
                }))
              }
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <label htmlFor="exempt-pinned" className="font-medium text-sm">
              Keep pinned conversations
            </label>
            <p className="mt-0.5 text-[var(--text-muted)] text-xs">
              Pinned conversations are never removed automatically. The user marked them
              deliberately.
            </p>
          </div>
          <Switch
            id="exempt-pinned"
            checked={draft.exemptPinnedThreads}
            onCheckedChange={(exemptPinnedThreads) =>
              setDraft((current) => ({ ...current, exemptPinnedThreads }))
            }
          />
        </div>

        {draft.threadRetentionDays !== null && (
          <Notice tone="warning" title="Conversations will be removed automatically">
            Conversations with no activity for {draft.threadRetentionDays} days move to the trash,
            then are destroyed {draft.trashRetentionDays} days later. Shared conversations are not
            exempt, so their links stop working when they are removed.
          </Notice>
        )}
      </EditableFieldset>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto text-[var(--danger)] text-sm">
              {error}
            </p>
          )}
          {saved && (
            <span className="mr-auto flex items-center gap-1.5 text-[var(--success)] text-sm">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            Save retention
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

export function AdminRetentionPage() {
  const retention = useQuery({
    queryKey: ['admin', 'retention'],
    queryFn: () => api.get<RetentionSettings>('/admin/lifecycle/retention'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Retention"
        description="How long conversations and history are kept. Everything deleted goes to a recoverable trash first, so a policy set too aggressively can still be undone."
      />

      {retention.data ? (
        <RetentionForm settings={retention.data} />
      ) : retention.isError ? (
        <LoadError title="Retention settings could not be loaded." query={retention} />
      ) : (
        <div role="status" aria-label="Loading retention settings">
          <Spinner className="mx-auto size-5" />
        </div>
      )}
    </div>
  );
}
