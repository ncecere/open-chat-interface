import { MIN_TRASH_RETENTION_DAYS, type RetentionSettings } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EditableFieldset, EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, LoadError, Notice } from '~/components/admin/admin-ui';
import {
  CONFIG_SOURCES_QUERY_KEY,
  ConfigSourceBadge,
  type ConfigSources,
  useConfigSources,
} from '~/components/admin/config-source';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api, apiErrorMessage } from '~/lib/api-client';

/** The form's names for the fields, as the API names them (#127). */
const RETENTION_LABELS = {
  trashRetentionDays: 'Trash retention (days)',
  threadRetentionDays: 'Conversation retention (days)',
  usageEventRetentionDays: 'Usage history (days)',
  displayTimezone: 'Reporting timezone',
  auditLogRetentionDays: 'Audit log (days)',
  memoryRetentionDays: 'Memory retention (days)',
};

/**
 * Only changed fields are sent: saving one value must not pin the others,
 * which would turn an environment-provided value into a saved one.
 */
function changedRetention(saved: RetentionSettings, draft: RetentionSettings) {
  const patch: Partial<RetentionSettings> = {};
  for (const key of Object.keys(saved) as Array<keyof RetentionSettings>) {
    if (saved[key] !== draft[key]) Object.assign(patch, { [key]: draft[key] });
  }
  return patch;
}

function RetentionForm({
  settings,
  sources,
}: {
  settings: RetentionSettings;
  sources: ConfigSources['retention'] | undefined;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const patch = changedRetention(settings, draft);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);

  const save = useMutation({
    mutationFn: () => api.put<RetentionSettings>('/admin/lifecycle/retention', patch),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'retention'] }),
        queryClient.invalidateQueries({ queryKey: CONFIG_SOURCES_QUERY_KEY }),
      ]);
    },
    onError: (cause) =>
      setError(apiErrorMessage(cause, 'Retention could not be saved.', RETENTION_LABELS)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges) save.mutate();
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
              aria-describedby={sources ? 'trash-days-source' : undefined}
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
            <ConfigSourceBadge id="trash-days-source" source={sources?.trashRetentionDays} />
          </Field>

          <Field
            label="Conversation retention (days)"
            htmlFor="thread-days"
            hint="Inactive conversations move to trash after this long. Leave blank to keep them forever."
          >
            <Input
              id="thread-days"
              aria-describedby={sources ? 'thread-days-source' : undefined}
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
            <ConfigSourceBadge id="thread-days-source" source={sources?.threadRetentionDays} />
          </Field>

          <Field
            label="Usage history (days)"
            htmlFor="usage-days"
            hint="Per-message usage rows. Daily totals are kept regardless."
          >
            <Input
              id="usage-days"
              aria-describedby={sources ? 'usage-days-source' : undefined}
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
            <ConfigSourceBadge id="usage-days-source" source={sources?.usageEventRetentionDays} />
          </Field>

          <Field
            label="Reporting timezone"
            htmlFor="display-timezone"
            hint="Where a day starts and ends on the Usage page, and the date models are told. Limits reset on their own policy's timezone, which this does not change."
          >
            <Input
              id="display-timezone"
              aria-describedby={sources ? 'display-timezone-source' : undefined}
              value={draft.displayTimezone}
              placeholder="UTC"
              onChange={(event) =>
                setDraft((current) => ({ ...current, displayTimezone: event.target.value }))
              }
            />
            <ConfigSourceBadge id="display-timezone-source" source={sources?.displayTimezone} />
          </Field>

          <Field
            label="Audit log (days)"
            htmlFor="audit-days"
            hint="Security-relevant entries such as role and credential changes are kept regardless."
          >
            <Input
              id="audit-days"
              aria-describedby={sources ? 'audit-days-source' : undefined}
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
            <ConfigSourceBadge id="audit-days-source" source={sources?.auditLogRetentionDays} />
          </Field>

          <Field
            label="Memory retention (days)"
            htmlFor="memory-days"
            hint="Memories not updated for this long are deleted. Leave blank to keep them until the person deletes them."
          >
            <Input
              id="memory-days"
              aria-describedby={sources ? 'memory-days-source' : undefined}
              type="number"
              min="1"
              placeholder="Never"
              value={draft.memoryRetentionDays ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  memoryRetentionDays: event.target.value ? Number(event.target.value) : null,
                }))
              }
            />
            <ConfigSourceBadge id="memory-days-source" source={sources?.memoryRetentionDays} />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="exempt-pinned" className="font-medium text-sm">
                Keep pinned conversations
              </label>
              <ConfigSourceBadge id="exempt-pinned-source" source={sources?.exemptPinnedThreads} />
            </div>
            <p className="mt-0.5 text-[var(--text-muted)] text-xs">
              Pinned conversations are never removed automatically. The user marked them
              deliberately.
            </p>
          </div>
          <Switch
            id="exempt-pinned"
            aria-describedby={sources ? 'exempt-pinned-source' : undefined}
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
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
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
  // Sources are a label beside each field; the form works without them.
  const sources = useConfigSources();

  return (
    <div>
      <AdminPageHeader
        title="Retention"
        description="How long conversations and history are kept. Everything deleted goes to a recoverable trash first, so a policy set too aggressively can still be undone. Each field shows whether its value is saved here, comes from the environment, or is the built-in default."
      />

      {retention.data ? (
        <RetentionForm settings={retention.data} sources={sources.data?.retention} />
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
