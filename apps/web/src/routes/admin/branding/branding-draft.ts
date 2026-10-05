import {
  type ColorTheme,
  type InstanceSettings,
  isSafeImageUrl,
  type ThemeMode,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { Monitor, Moon, Sun } from 'lucide-react';

export type BrandingSettings = Pick<
  InstanceSettings,
  'appName' | 'shortName' | 'logoUrl' | 'colorTheme' | 'loginMessage' | 'defaultTheme'
>;
export type BrandingPatch = Partial<BrandingSettings>;
export type BrandingErrors = Partial<Record<keyof BrandingSettings, string>>;

/**
 * The accent is one of the built-in color themes, which diagrams follow too.
 * The hex `accentColor` is an API-only override for diagram colours (see the
 * administration guide), so this page neither shows nor sends it.
 */
export const COLOR_THEME_LABELS: Record<ColorTheme, string> = {
  neutral: 'Neutral',
  blue: 'Blue',
  violet: 'Violet',
  emerald: 'Emerald',
};

export const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export const THEME_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} satisfies Record<ThemeMode, typeof Sun>;

export function brandingFromResponse(settings: InstanceSettings): BrandingSettings {
  return {
    appName: settings.appName,
    shortName: settings.shortName,
    logoUrl: settings.logoUrl,
    colorTheme: settings.colorTheme,
    loginMessage: settings.loginMessage,
    defaultTheme: settings.defaultTheme,
  };
}

export function normalizeBranding(settings: BrandingSettings): BrandingSettings {
  return {
    appName: settings.appName.trim(),
    shortName: settings.shortName?.trim() || null,
    logoUrl: settings.logoUrl?.trim() || null,
    colorTheme: settings.colorTheme,
    loginMessage: settings.loginMessage?.trim() || null,
    defaultTheme: settings.defaultTheme,
  };
}

export function changedBranding(saved: BrandingSettings, draft: BrandingSettings): BrandingPatch {
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

export function validateBranding(settings: BrandingSettings): BrandingErrors {
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
