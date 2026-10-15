import {
  type AdminClassification,
  CLASSIFICATION_MODES,
  type ClassificationMode,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Notice, SaveRow, SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { ADMIN_CLASSIFICATION_KEY } from '~/hooks/use-admin-classification';
import { ApiError, api, apiErrorMessage } from '~/lib/api-client';
import { countOf } from '~/lib/classification';
import { cn } from '~/lib/utils';

const MODE_LABELS: Record<ClassificationMode, { label: string; sentence: string }> = {
  off: {
    label: 'Off',
    sentence: 'Nothing is checked and nothing changes for anyone.',
  },
  warn: {
    label: 'Warn',
    sentence:
      'Nothing is refused: what Block would have refused goes ahead, with a notice, and is recorded in the audit log.',
  },
  block: {
    label: 'Block',
    sentence:
      'Anything that would carry a class to a model or service that is not approved for it is refused.',
  },
};

/** What the API says (409) when `migrate --post` has not run yet, in words an administrator can act on. */
export const MODE_NOT_AVAILABLE_TEXT =
  'The mode was not changed. The upgrade to 0.14 has not finished on every server, so Warn and Block cannot be turned on yet. Run “migrate --post” (see Upgrading to v0.14 in the operations guide), then try again.';

function modeErrorText(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 409) return MODE_NOT_AVAILABLE_TEXT;
  return apiErrorMessage(error, 'The mode could not be changed.');
}

/** What to tell an administrator about an upgrade or backfill that is not finished, before they choose a mode. */
export function UpgradeBanners({ settings }: { settings: AdminClassification }) {
  return (
    <>
      {!settings.modeAvailable && (
        <Notice tone="warning" title="The upgrade to 0.14 is not finished">
          Warn and Block stay unavailable until every server runs 0.14 and{' '}
          <code>migrate --post</code> has run. Servers still on v0.13 do not check data
          classification at all, so turning it on earlier would give a false sense of safety. See
          Upgrading to v0.14 in the operations guide.
        </Notice>
      )}
      {settings.modeAvailable && !settings.backfillDone && (
        <Notice title="Finding which conversations used connectors before 0.14">
          A background migration is reading stored conversations for connector tools used before
          0.14. Until it finishes, OCI also reads each conversation’s own messages whenever it
          decides, so nothing is missed. Progress is under{' '}
          <Link to="/admin/health" className="underline">
            System health
          </Link>
          .
        </Notice>
      )}
      {settings.mode !== 'off' && settings.unreviewedConnectorCount > 0 && (
        <Notice tone="warning" title="Some connectors are not reviewed">
          {countOf(settings.unreviewedConnectorCount, 'connector')} still{' '}
          {settings.unreviewedConnectorCount === 1 ? 'has' : 'have'} no statement of what{' '}
          {settings.unreviewedConnectorCount === 1 ? 'it carries' : 'they carry'}. A connector
          nobody has labelled is not affected by any decision. Open{' '}
          <Link to="/admin/connectors" className="underline">
            Connectors
          </Link>{' '}
          and choose what each carries, or that it carries no classified data.
        </Notice>
      )}
    </>
  );
}

/** Off, Warn or Block, each with one sentence, saved with its own button. */
export function ModeSection({ settings }: { settings: AdminClassification }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ClassificationMode>(settings.mode);
  const dirty = mode !== settings.mode;
  useReportUnsaved(dirty);
  const save = useMutation({
    mutationFn: () => api.patch('/admin/classification', { mode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_CLASSIFICATION_KEY }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) save.mutate();
  }

  return (
    <SettingsSection
      title="Mode"
      description="Warn is a dry run of Block: turn it on first, read the audit log for what it would have refused, then switch to Block."
    >
      <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-5">
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Data classification mode</legend>
          {CLASSIFICATION_MODES.map((value) => {
            const id = `classification-mode-${value}`;
            const checked = mode === value;
            return (
              <label
                key={value}
                htmlFor={id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3',
                  checked
                    ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/40',
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="classification-mode"
                  value={value}
                  checked={checked}
                  onChange={() => {
                    save.reset();
                    setMode(value);
                  }}
                  className="mt-1 size-4 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text-primary)]">
                    {MODE_LABELS[value].label}
                    {settings.mode === value && (
                      <span className="ms-2 text-xs font-normal text-[var(--text-muted)]">
                        (current)
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-sm text-[var(--text-muted)]">
                    {MODE_LABELS[value].sentence}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <SaveRow
          hasChanges={dirty}
          isPending={save.isPending}
          errorMessage={modeErrorText(save.error)}
          successMessage={save.isSuccess && !dirty ? 'Mode saved.' : null}
          subject="the mode"
        />
      </form>
    </SettingsSection>
  );
}
