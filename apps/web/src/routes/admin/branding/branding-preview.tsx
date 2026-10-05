import { isSafeImageUrl } from '@oci/shared';
import { useState } from 'react';
import { TurnsMark } from '~/components/brand/turns-mark';
import { cn } from '~/lib/utils';
import {
  type BrandingSettings,
  normalizeBranding,
  THEME_ICONS,
  THEME_LABELS,
} from './branding-draft';

export function BrandingPreview({ settings }: { settings: BrandingSettings }) {
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
