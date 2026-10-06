import {
  COLOR_THEMES,
  type InstanceSettings,
  THEME_MODES,
  type ThemeMode,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, RotateCcw } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { problemsElsewhere } from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';
import {
  type BrandingErrors,
  type BrandingPatch,
  type BrandingSettings,
  COLOR_THEME_LABELS,
  changedBranding,
  normalizeBranding,
  THEME_LABELS,
  validateBranding,
} from './branding-draft';
import { BrandingPreview } from './branding-preview';
import { LogoUpload } from './logo-upload';

/** The fields that show their own errors; any other is shown beside Save (#302). */
const BRANDING_FIELDS = ['appName', 'shortName', 'logoUrl', 'loginMessage'] as const;

/** The page's names for the fields, so a refusal names the one it is about (#127). */
const BRANDING_LABELS = {
  appName: 'App name',
  shortName: 'Short name',
  logoUrl: 'Logo URL',
  loginMessage: 'Login message',
};

export function BrandingForm({ initialSettings }: { initialSettings: BrandingSettings }) {
  const queryClient = useQueryClient();
  const { resolvedTheme, setColorTheme } = useTheme();
  const [saved, setSaved] = useState(() => normalizeBranding(initialSettings));
  const [draft, setDraft] = useState(() => normalizeBranding(initialSettings));
  const [errors, setErrors] = useState<BrandingErrors>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(errorMessage, () => setErrorMessage(null));
  const [savedMessage, setSavedMessage] = useState(false);

  const patch = changedBranding(saved, draft);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);

  const save = useMutation({
    mutationFn: (changes: BrandingPatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', updateInstanceSettingsSchema.parse(changes)),
    onSuccess: (_response, changes) => {
      const nextSaved = { ...saved, ...changes };
      setSaved(nextSaved);
      setDraft(nextSaved);
      setErrors({});
      setErrorMessage(null);
      setSavedMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, ...changes } : current,
      );
      // Apply a new accent immediately rather than at the next status refetch;
      // the refetch also carries the name, logo and default theme to the app.
      if (changes.colorTheme) setColorTheme(changes.colorTheme);
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
    onError: (error) => {
      setSavedMessage(false);
      // Each refusal at the field the API names, as the form's own checks
      // are; only one about no field beside Save (#317's sweep).
      const problems = apiErrorProblems(
        error,
        'Unable to save branding settings.',
        BRANDING_LABELS,
      );
      setErrors(
        Object.fromEntries(
          problems.flatMap(({ fields: [field], text }) =>
            (BRANDING_FIELDS as readonly string[]).includes(field ?? '') ? [[field, text]] : [],
          ),
        ),
      );
      setErrorMessage(problemsElsewhere(problems, BRANDING_FIELDS));
    },
  });

  function updateField<Key extends keyof BrandingSettings>(key: Key, value: BrandingSettings[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setErrorMessage(null);
    setSavedMessage(false);
    save.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateBranding(draft);
    setErrors(nextErrors);
    setErrorMessage(null);
    setSavedMessage(false);

    if (Object.keys(nextErrors).length === 0 && hasChanges) {
      save.mutate(patch);
    }
  }

  function resetForm() {
    setDraft(saved);
    setErrors({});
    setErrorMessage(null);
    setSavedMessage(false);
    save.reset();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          <SettingsSection
            stacked
            title="Identity"
            description="Set the name and logo shown to people using this instance."
          >
            <div className="flex flex-col gap-5">
              <Field
                label="App name"
                htmlFor="app-name"
                hint="Shown on the sign-in pages, in the sidebar and browser tab, on shared conversations, in emails and in exported files. Maximum 80 characters."
              >
                <Input
                  id="app-name"
                  value={draft.appName}
                  maxLength={81}
                  disabled={save.isPending}
                  aria-invalid={Boolean(errors.appName)}
                  aria-describedby={errors.appName ? 'app-name-error' : undefined}
                  onChange={(event) => updateField('appName', event.target.value)}
                />
                {errors.appName && (
                  <p id="app-name-error" role="alert" className="text-xs text-[var(--danger)]">
                    {errors.appName}
                  </p>
                )}
              </Field>

              <Field
                label="Short name"
                htmlFor="short-name"
                hint="Optional compact name for the sidebar and shared conversations. When blank, the full name is shown, or its initials if it is longer than 20 characters."
              >
                <Input
                  id="short-name"
                  value={draft.shortName ?? ''}
                  maxLength={13}
                  placeholder="OCI"
                  disabled={save.isPending}
                  aria-invalid={Boolean(errors.shortName)}
                  aria-describedby={errors.shortName ? 'short-name-error' : undefined}
                  onChange={(event) => updateField('shortName', event.target.value || null)}
                />
                {errors.shortName && (
                  <p id="short-name-error" role="alert" className="text-xs text-[var(--danger)]">
                    {errors.shortName}
                  </p>
                )}
              </Field>

              <LogoUpload currentLogoUrl={draft.logoUrl} />

              <Field
                label="Logo URL"
                htmlFor="logo-url"
                hint="Set automatically when a file is uploaded. You can also point at an external image instead."
              >
                <Input
                  id="logo-url"
                  type="text"
                  inputMode="url"
                  value={draft.logoUrl ?? ''}
                  placeholder="https://example.com/logo.svg"
                  disabled={save.isPending}
                  aria-invalid={Boolean(errors.logoUrl)}
                  aria-describedby={errors.logoUrl ? 'logo-url-error' : undefined}
                  onChange={(event) => updateField('logoUrl', event.target.value || null)}
                />
                {errors.logoUrl && (
                  <p id="logo-url-error" role="alert" className="text-xs text-[var(--danger)]">
                    {errors.logoUrl}
                  </p>
                )}
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection
            stacked
            title="Appearance"
            description="Choose the accent color and the default light or dark theme."
          >
            <div className="flex flex-col gap-5">
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-sm font-medium text-[var(--text-primary)]">
                  Accent color
                </legend>
                <div className="flex flex-wrap gap-3">
                  {COLOR_THEMES.map((theme) => {
                    const selected = draft.colorTheme === theme;
                    return (
                      <label
                        key={theme}
                        data-color-theme={theme}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]',
                          // Accent tokens differ between light and dark, so a
                          // swatch carries the active mode to show the right one.
                          resolvedTheme,
                          selected
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/50',
                        )}
                      >
                        <input
                          type="radio"
                          name="color-theme"
                          value={theme}
                          checked={selected}
                          disabled={save.isPending}
                          className="sr-only"
                          onChange={() => updateField('colorTheme', theme)}
                        />
                        <span
                          aria-hidden="true"
                          className="flex size-6 items-center justify-center rounded-full bg-[var(--accent)]"
                        >
                          {selected && (
                            <Check className="size-3.5 text-[var(--accent-foreground)]" />
                          )}
                        </span>
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {COLOR_THEME_LABELS[theme]}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  Applied to buttons, links and highlights across the instance, and to diagrams the
                  assistant draws. Surfaces stay neutral.
                </p>
              </fieldset>

              <Field
                label="Default theme"
                htmlFor="default-theme"
                hint="Used by anyone who has not picked a theme themselves. System follows each person's operating system preference."
              >
                <Select
                  id="default-theme"
                  value={draft.defaultTheme}
                  disabled={save.isPending}
                  onChange={(next) => updateField('defaultTheme', next as ThemeMode)}
                  options={THEME_MODES.map((theme) => ({
                    value: theme,
                    label: THEME_LABELS[theme],
                  }))}
                />
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection
            stacked
            title="Sign-in message"
            description="Add a short welcome or usage notice to the sign-in page."
          >
            <Field
              label="Login message"
              htmlFor="login-message"
              hint={`${draft.loginMessage?.length ?? 0}/240 characters. Leave blank to use the default message.`}
            >
              <Textarea
                id="login-message"
                rows={4}
                maxLength={241}
                value={draft.loginMessage ?? ''}
                placeholder="Sign in to continue to your conversations."
                disabled={save.isPending}
                aria-invalid={Boolean(errors.loginMessage)}
                aria-describedby={errors.loginMessage ? 'login-message-error' : undefined}
                onChange={(event) => updateField('loginMessage', event.target.value || null)}
              />
              {errors.loginMessage && (
                <p id="login-message-error" role="alert" className="text-xs text-[var(--danger)]">
                  {errors.loginMessage}
                </p>
              )}
            </Field>
          </SettingsSection>
        </div>

        <BrandingPreview settings={draft} />
      </div>

      <EditOnly>
        <div className="mt-8 flex min-h-10 flex-col-reverse gap-3 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center sm:justify-end">
          <div className="sm:mr-auto" aria-live="polite">
            {errorMessage && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {errorMessage}
              </p>
            )}
            {savedMessage && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Branding settings saved.
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            disabled={!hasChanges || save.isPending}
            onClick={resetForm}
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}
