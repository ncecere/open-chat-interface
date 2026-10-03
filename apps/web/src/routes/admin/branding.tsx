import {
  COLOR_THEMES,
  type ColorTheme,
  type InstanceSettings,
  instanceSettingsSchema,
  THEME_MODES,
  type ThemeMode,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, SettingsSection } from '~/components/admin/admin-ui';
import { TurnsMark } from '~/components/brand/turns-mark';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

type BrandingSettings = Pick<
  InstanceSettings,
  'appName' | 'shortName' | 'logoUrl' | 'colorTheme' | 'loginMessage' | 'defaultTheme'
>;
type BrandingPatch = Partial<BrandingSettings>;
type BrandingErrors = Partial<Record<keyof BrandingSettings, string>>;

/**
 * The accent is one of the built-in color themes, which diagrams follow too.
 * The hex `accentColor` is an API-only override for diagram colours (see the
 * administration guide), so this page neither shows nor sends it.
 */
const COLOR_THEME_LABELS: Record<ColorTheme, string> = {
  neutral: 'Neutral',
  blue: 'Blue',
  violet: 'Violet',
  emerald: 'Emerald',
};

const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const THEME_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} satisfies Record<ThemeMode, typeof Sun>;

function brandingFromResponse(settings: InstanceSettings): BrandingSettings {
  return {
    appName: settings.appName,
    shortName: settings.shortName,
    logoUrl: settings.logoUrl,
    colorTheme: settings.colorTheme,
    loginMessage: settings.loginMessage,
    defaultTheme: settings.defaultTheme,
  };
}

function normalizeBranding(settings: BrandingSettings): BrandingSettings {
  return {
    appName: settings.appName.trim(),
    shortName: settings.shortName?.trim() || null,
    logoUrl: settings.logoUrl?.trim() || null,
    colorTheme: settings.colorTheme,
    loginMessage: settings.loginMessage?.trim() || null,
    defaultTheme: settings.defaultTheme,
  };
}

function changedBranding(saved: BrandingSettings, draft: BrandingSettings): BrandingPatch {
  const normalized = normalizeBranding(draft);
  const patch: BrandingPatch = {};

  for (const key of [
    'appName',
    'shortName',
    'logoUrl',
    'colorTheme',
    'loginMessage',
    'defaultTheme',
  ] as const) {
    if (saved[key] !== normalized[key]) {
      Object.assign(patch, { [key]: normalized[key] });
    }
  }

  return patch;
}

function isSafeImageUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function validateBranding(settings: BrandingSettings): BrandingErrors {
  const normalized = normalizeBranding(settings);
  const errors: BrandingErrors = {};

  if (!normalized.appName) {
    errors.appName = 'App name is required.';
  } else if (normalized.appName.length > 80) {
    errors.appName = 'App name must be 80 characters or fewer.';
  }

  if (normalized.shortName && normalized.shortName.length > 12) {
    errors.shortName = 'Short name must be 12 characters or fewer.';
  }

  if (normalized.logoUrl) {
    if (normalized.logoUrl.length > 2_048) {
      errors.logoUrl = 'Logo URL must be 2,048 characters or fewer.';
    } else if (!isSafeImageUrl(normalized.logoUrl)) {
      errors.logoUrl = 'Use an http(s) URL or a root-relative path beginning with /.';
    }
  }

  if (normalized.loginMessage && normalized.loginMessage.length > 240) {
    errors.loginMessage = 'Login message must be 240 characters or fewer.';
  }

  if (!updateInstanceSettingsSchema.safeParse(normalized).success) {
    errors.defaultTheme ??= 'Select a valid theme.';
  }

  return errors;
}

function LoadingBranding() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]"
      role="status"
      aria-busy="true"
      aria-label="Loading branding settings"
    >
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
          <Spinner />
          Loading branding settings…
        </div>
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="animate-pulse">
            <div className="h-4 w-32 rounded bg-[var(--bg-control-hover)]" />
            <div className="mt-2 h-9 rounded bg-[var(--bg-control-hover)]" />
          </div>
        ))}
      </div>
      <div className="min-h-96 animate-pulse rounded-xl bg-[var(--bg-control-hover)]/50" />
    </div>
  );
}

function BrandingPreview({ settings }: { settings: BrandingSettings }) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const normalized = normalizeBranding(settings);
  const logoUrl =
    normalized.logoUrl && isSafeImageUrl(normalized.logoUrl) ? normalized.logoUrl : null;
  const systemIsDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark =
    normalized.defaultTheme === 'dark' || (normalized.defaultTheme === 'system' && systemIsDark);
  const palette = dark
    ? { background: '#171317', panel: '#231e24', text: '#f8f7fa', muted: '#a99da8' }
    : { background: '#f7f1f7', panel: '#ffffff', text: '#2f1c2c', muted: '#796a77' };
  const PreviewThemeIcon = THEME_ICONS[normalized.defaultTheme];

  return (
    <div className="min-w-0 lg:sticky lg:top-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Live preview</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
          <PreviewThemeIcon className="size-3.5" aria-hidden="true" />
          {THEME_LABELS[normalized.defaultTheme]}
        </span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
        A safe approximation of the sign-in experience.
      </p>
      <div className="mt-5">
        {/* The accent comes from the chosen theme's own tokens, in the
            previewed light or dark variant, so it matches the live app. */}
        <div
          data-testid="branding-preview"
          data-color-theme={normalized.colorTheme}
          className={cn(
            'flex min-h-96 items-center justify-center rounded-xl border border-black/10 p-5 transition-colors sm:p-8',
            dark ? 'dark' : 'light',
          )}
          style={{ backgroundColor: palette.background, color: palette.text }}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-black/10 p-6 shadow-sm transition-colors"
            style={{ backgroundColor: palette.panel }}
          >
            <div className="mb-6 flex min-h-12 items-center justify-center">
              {logoUrl && failedLogo !== logoUrl ? (
                <img
                  key={logoUrl}
                  src={logoUrl}
                  alt="Brand logo preview"
                  className="max-h-12 max-w-48 object-contain"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedLogo(logoUrl)}
                />
              ) : (
                // Without a logo the app shows the Open Chat Interface mark.
                <TurnsMark className="size-11" />
              )}
            </div>
            <h2 className="text-center text-xl font-semibold">
              {normalized.appName || 'Your app name'}
            </h2>
            <p
              className="mt-2 min-h-10 text-center text-sm leading-relaxed"
              style={{ color: palette.muted }}
            >
              {normalized.loginMessage || 'Sign in to continue to your conversations.'}
            </p>
            <div className="mt-6 space-y-3" aria-hidden="true">
              <div className="h-9 rounded-lg border border-black/15" />
              <div className="h-9 rounded-lg border border-black/15" />
              <div className="flex h-9 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-medium text-[var(--accent-foreground)]">
                Sign in
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
          External logo previews are loaded by your browser without sending a referrer.
        </p>
      </div>
    </div>
  );
}

function BrandingForm({ initialSettings }: { initialSettings: BrandingSettings }) {
  const queryClient = useQueryClient();
  const { resolvedTheme, setColorTheme } = useTheme();
  const [saved, setSaved] = useState(() => normalizeBranding(initialSettings));
  const [draft, setDraft] = useState(() => normalizeBranding(initialSettings));
  const [errors, setErrors] = useState<BrandingErrors>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);

  const patch = changedBranding(saved, draft);
  const hasChanges = Object.keys(patch).length > 0;

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
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save branding settings.',
      );
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

/**
 * Uploads a logo file rather than requiring one to be hosted elsewhere.
 *
 * The file is stored by the instance, so branding does not break when an
 * external host changes or disappears. Saving is immediate: an upload is not a
 * draft edit, and pairing it with the surrounding form's save button would
 * suggest it could be reverted by discarding changes.
 */
function LogoUpload({ currentLogoUrl }: { currentLogoUrl: string | null }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/admin/settings/logo', {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? 'The logo could not be uploaded.');
      }
    },
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['auth', 'status'] }),
      ]);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Upload failed.'),
  });

  return (
    <Field
      label="Logo file"
      hint="PNG, JPEG, or WebP up to 1 MB. Shown in place of the Open Chat Interface mark and name, and used as the browser tab icon."
    >
      <div className="flex flex-wrap items-center gap-3">
        {currentLogoUrl && (
          <img
            src={currentLogoUrl}
            alt="Current logo"
            className="h-10 w-auto max-w-40 rounded border border-[var(--border-subtle)] bg-[var(--bg-control)] object-contain p-1"
          />
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            // Clear so choosing the same file twice still fires a change.
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending && <Spinner />}
          {currentLogoUrl ? 'Replace logo' : 'Upload logo'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </Field>
  );
}

export function AdminBrandingPage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => instanceSettingsSchema.parse(await api.get<unknown>('/admin/settings')),
  });

  return (
    <div>
      <AdminPageHeader
        title="Branding"
        description="Customize the identity and default appearance of your Open Chat Interface instance."
      />

      {settings.isLoading ? (
        <LoadingBranding />
      ) : settings.isError || !settings.data ? (
        <div>
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load branding settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />}
            Try again
          </Button>
        </div>
      ) : (
        <BrandingForm initialSettings={brandingFromResponse(settings.data)} />
      )}
    </div>
  );
}
