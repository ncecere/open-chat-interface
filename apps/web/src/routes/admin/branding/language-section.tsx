import {
  type InstanceSettings,
  type LanguageSettings,
  normalizeLanguageSettings,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useId, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { LOCALES } from '~/locales';
import en from '~/locales/en.json';

/**
 * Admin → Branding → Language (v0.14, #397): the language people get who have
 * not chosen one, and the languages they may choose. English is always on.
 *
 * The administration console itself stays in English whatever is chosen here:
 * this setting is for the pages people chat in. It saves on its own (the rest
 * of Branding has a Save button of its own), and a language switched off is
 * not deleted from anyone's profile, they just see the default until it is
 * switched on again.
 *
 * Written in English on purpose: the admin console is not translated, so these
 * literals are outside the migrated directories.
 */
const NOT_CHOSEN = '';

function describe(tag: SupportedLocale): string {
  const name = en[`language.name.${tag}`];
  return LOCALES[tag].beta ? `${name} (beta)` : name;
}

function same(left: LanguageSettings, right: LanguageSettings): boolean {
  return left.default === right.default && left.enabled.join() === right.enabled.join();
}

export function LanguageSection({ language }: { language: LanguageSettings | undefined }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [saved, setSaved] = useState(() => normalizeLanguageSettings(language));
  const [draft, setDraft] = useState(saved);
  const [confirmed, setConfirmed] = useState(false);
  const dirty = !same(saved, draft);
  useReportUnsaved(dirty);

  const save = useMutation({
    mutationFn: (next: LanguageSettings) =>
      api.patch<{ ok: boolean }>(
        '/admin/settings',
        updateInstanceSettingsSchema.parse({ language: next }),
      ),
    onSuccess: (_response, next) => {
      setSaved(next);
      setDraft(next);
      setConfirmed(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, language: next } : current,
      );
      // The public status carries it to the sign-in page and every person's picker.
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
  });

  function toggle(tag: SupportedLocale, on: boolean) {
    setConfirmed(false);
    save.reset();
    setDraft((current) => {
      const enabled = SUPPORTED_LOCALES.filter(
        (candidate) =>
          candidate === 'en' || (candidate === tag ? on : current.enabled.includes(candidate)),
      );
      // A language switched off cannot stay the default.
      return {
        enabled,
        default: current.default && enabled.includes(current.default) ? current.default : null,
      };
    });
  }

  return (
    <SettingsSection
      stacked
      title="Language"
      description="The language the web app is shown in, for people who have not chosen their own. The administration console stays in English."
    >
      <div className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-[var(--text-primary)]">
            Languages people can choose
          </legend>
          {SUPPORTED_LOCALES.map((tag) => (
            <label
              key={tag}
              className="flex items-center gap-2.5 text-sm text-[var(--text-primary)]"
            >
              <input
                type="checkbox"
                checked={draft.enabled.includes(tag)}
                disabled={tag === 'en' || save.isPending}
                onChange={(event) => toggle(tag, event.target.checked)}
              />
              <span>
                {describe(tag)}
                {tag === 'en' && ' (always on)'}
              </span>
            </label>
          ))}
          <p className="text-xs text-[var(--text-muted)]">
            Beta languages are machine-drafted and have not been reviewed by a native reader. Turn
            one on once someone who reads it has looked it over.
          </p>
        </fieldset>

        <Field
          label="Default language"
          htmlFor={`${id}-default`}
          hint="Used by anyone who has not chosen a language. “Follow the browser” picks the first of the person's browser languages that is turned on above, else English."
        >
          <Select
            id={`${id}-default`}
            value={draft.default ?? NOT_CHOSEN}
            disabled={save.isPending}
            onChange={(next) => {
              setConfirmed(false);
              save.reset();
              setDraft((current) => ({
                ...current,
                default: next === NOT_CHOSEN ? null : (next as SupportedLocale),
              }));
            }}
            options={[
              { value: NOT_CHOSEN, label: 'Follow the browser' },
              ...draft.enabled.map((tag) => ({ value: tag, label: describe(tag) })),
            ]}
          />
        </Field>

        <EditOnly>
          <div className="flex min-h-10 items-center gap-3" aria-live="polite">
            {save.isError && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {apiErrorMessage(save.error, 'Unable to save the language settings.')}
              </p>
            )}
            {confirmed && !dirty && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Language settings saved.
              </p>
            )}
            <Button
              type="button"
              variant="primary"
              className="ms-auto"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending && <Spinner />}
              {save.isPending ? 'Saving…' : 'Save language'}
            </Button>
          </div>
        </EditOnly>
      </div>
    </SettingsSection>
  );
}
