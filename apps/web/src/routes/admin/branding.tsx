import {
  type InstanceSettings,
  instanceSettingsSchema,
  THEME_MODES,
  type ThemeMode,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ImageIcon, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AdminPageHeader, SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';

type BrandingSettings = Pick<
  InstanceSettings,
  'appName' | 'logoUrl' | 'accentColor' | 'loginMessage' | 'defaultTheme'
>;
type BrandingPatch = Partial<BrandingSettings>;
type BrandingErrors = Partial<Record<keyof BrandingSettings, string>>;

const DEFAULT_ACCENT = '#97124f';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
    logoUrl: settings.logoUrl,
    accentColor: settings.accentColor,
    loginMessage: settings.loginMessage,
    defaultTheme: settings.defaultTheme,
  };
}

function normalizeBranding(settings: BrandingSettings): BrandingSettings {
  return {
    appName: settings.appName.trim(),
    logoUrl: settings.logoUrl?.trim() || null,
    accentColor: settings.accentColor?.trim().toLowerCase() || null,
    loginMessage: settings.loginMessage?.trim() || null,
    defaultTheme: settings.defaultTheme,
  };
}

function changedBranding(saved: BrandingSettings, draft: BrandingSettings): BrandingPatch {
  const normalized = normalizeBranding(draft);
  const patch: BrandingPatch = {};

  for (const key of [
    'appName',
    'logoUrl',
    'accentColor',
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

  if (normalized.logoUrl) {
    if (normalized.logoUrl.length > 2_048) {
      errors.logoUrl = 'Logo URL must be 2,048 characters or fewer.';
    } else if (!isSafeImageUrl(normalized.logoUrl)) {
      errors.logoUrl = 'Use an http(s) URL or a root-relative path beginning with /.';
    }
  }

  if (normalized.accentColor && !HEX_COLOR.test(normalized.accentColor)) {
    errors.accentColor = 'Use a six-digit hex color, such as #97124f.';
  }

  if (normalized.loginMessage && normalized.loginMessage.length > 240) {
    errors.loginMessage = 'Login message must be 240 characters or fewer.';
  }

  if (!updateInstanceSettingsSchema.safeParse(normalized).success) {
    errors.defaultTheme ??= 'Select a valid theme.';
  }

  return errors;
}

function textColorFor(background: string): string {
  const red = Number.parseInt(background.slice(1, 3), 16);
  const green = Number.parseInt(background.slice(3, 5), 16);
  const blue = Number.parseInt(background.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1_000;
  return luminance > 150 ? '#211820' : '#ffffff';
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
  const accent =
    normalized.accentColor && HEX_COLOR.test(normalized.accentColor)
      ? normalized.accentColor
      : DEFAULT_ACCENT;
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
        <div
          className="flex min-h-96 items-center justify-center rounded-xl border border-black/10 p-5 transition-colors sm:p-8"
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
                <div
                  className="flex size-11 items-center justify-center rounded-xl"
                  style={{ backgroundColor: accent, color: textColorFor(accent) }}
                  aria-hidden="true"
                >
                  <ImageIcon className="size-5" />
                </div>
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
              <div
                className="flex h-9 items-center justify-center rounded-lg text-sm font-medium"
                style={{ backgroundColor: accent, color: textColorFor(accent) }}
              >
                Sign in
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
          External logo previews are loaded by your browser without sending a referrer. Final colors
          may vary slightly by theme.
        </p>
      </div>
    </div>
  );
}

function BrandingForm({ initialSettings }: { initialSettings: BrandingSettings }) {
  const queryClient = useQueryClient();
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
            title="Identity"
            description="Set the name and logo shown to people using this instance."
          >
            <div className="flex flex-col gap-5">
              <Field
                label="App name"
                htmlFor="app-name"
                hint="Shown in the sign-in page and app navigation. Maximum 80 characters."
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
                label="Logo URL"
                htmlFor="logo-url"
                hint="Optional. Use an http(s) URL or a root-relative path. SVG is supported by most browsers."
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
            title="Appearance"
            description="Choose the default color and theme for the experience."
          >
            <div className="flex flex-col gap-5">
              <Field
                label="Accent color"
                htmlFor="accent-color"
                hint="Optional six-digit hex color. Clear it to use the OCI default."
              >
                <div className="flex gap-2">
                  <Input
                    id="accent-color"
                    value={draft.accentColor ?? ''}
                    placeholder={DEFAULT_ACCENT}
                    spellCheck={false}
                    disabled={save.isPending}
                    aria-invalid={Boolean(errors.accentColor)}
                    aria-describedby={errors.accentColor ? 'accent-color-error' : undefined}
                    onChange={(event) => updateField('accentColor', event.target.value || null)}
                  />
                  <input
                    type="color"
                    aria-label="Choose accent color"
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] p-1 disabled:cursor-not-allowed disabled:opacity-50"
                    value={
                      draft.accentColor && HEX_COLOR.test(draft.accentColor)
                        ? draft.accentColor
                        : DEFAULT_ACCENT
                    }
                    disabled={save.isPending}
                    onChange={(event) => updateField('accentColor', event.target.value)}
                  />
                </div>
                {errors.accentColor && (
                  <p id="accent-color-error" role="alert" className="text-xs text-[var(--danger)]">
                    {errors.accentColor}
                  </p>
                )}
              </Field>

              <Field
                label="Default theme"
                htmlFor="default-theme"
                hint="System follows each person's operating system preference."
              >
                <Select
                  id="default-theme"
                  value={draft.defaultTheme}
                  disabled={save.isPending}
                  aria-invalid={Boolean(errors.defaultTheme)}
                  onChange={(event) => updateField('defaultTheme', event.target.value as ThemeMode)}
                >
                  {THEME_MODES.map((theme) => (
                    <option key={theme} value={theme}>
                      {THEME_LABELS[theme]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection
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
    </form>
  );
}

export function AdminBrandingPage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => instanceSettingsSchema.parse(await api.get<unknown>('/admin/settings')),
  });

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AdminPageHeader
        title="Branding"
        description="Customize the identity and default appearance of your Open Chat Interface instance."
      />

      {settings.isLoading ? (
        <LoadingBranding />
      ) : settings.isError || !settings.data ? (
        <div className="max-w-3xl">
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
