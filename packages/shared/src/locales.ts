import { z } from 'zod';

/**
 * The languages the web app can be shown in (v0.14, #397). `en` is the source
 * and always complete; `es` and `ar` are machine-drafted and labelled beta
 * until a native reader has reviewed them (docs/dev/translations.md).
 *
 * The web app's registry (apps/web/src/locales/index.ts) carries the rest of
 * what it needs per language (its own name, direction, loader) and a unit
 * test keeps the two lists equal. Pseudo-locales for testing are web-only and
 * never stored.
 */
export const SUPPORTED_LOCALES = ['en', 'es', 'ar'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const SOURCE_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export const localeSchema = z.enum(SUPPORTED_LOCALES);

/**
 * The instance's language setting (Admin → Branding): the language people get
 * who have not chosen one, and the languages they may choose from. `default`
 * null means "follow each person's browser".
 */
export const languageSettingsSchema = z.object({
  default: localeSchema.nullable(),
  enabled: z.array(localeSchema).min(1),
});
export type LanguageSettings = z.infer<typeof languageSettingsSchema>;

/**
 * What an instance that never saved the setting has: English only, so
 * upgrading changes nothing until an administrator turns a language on.
 */
export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = { default: null, enabled: ['en'] };

/**
 * Reads a stored (or patched) language setting into a valid one: unknown
 * languages dropped, English always enabled, the list in registry order, and a
 * default that is not enabled read as none. Never throws, so a value written
 * by a newer release that knows more languages still reads.
 */
export function normalizeLanguageSettings(value: unknown): LanguageSettings {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as {
    default?: unknown;
    enabled?: unknown;
  };
  const listed = Array.isArray(stored.enabled) ? stored.enabled : [];
  const enabled = SUPPORTED_LOCALES.filter(
    (locale) => locale === SOURCE_LOCALE || listed.includes(locale),
  );
  const preferred = isSupportedLocale(stored.default) ? stored.default : null;
  return { default: preferred && enabled.includes(preferred) ? preferred : null, enabled };
}
