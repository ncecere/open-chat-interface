import { SUPPORTED_LOCALES, type SupportedLocale } from '@oci/shared';
import type { Catalog } from '~/lib/i18n/catalog';
import { pseudoCatalog } from '~/lib/i18n/pseudo';
import type en from './en.json';

/**
 * Every language the web app can show. Adding one is documented in
 * docs/dev/translations.md: a JSON catalog here, a line in this file, and the
 * tag in `SUPPORTED_LOCALES` (packages/shared/src/locales.ts).
 *
 * Every catalog, `en` included, is a dynamic import: a chunk of its own that
 * `activateLocale` fetches before the first render (`main.tsx`), so the strings
 * are never in the initial JavaScript however many there are. `en` is the
 * source, always complete, and is loaded next to any other language as the
 * fallback for a key that language lacks. The catalogs are checked against `en`
 * by `scripts/check-i18n.mjs`; the keys are typed from `en.json` through a
 * type-only import, so nothing here pulls the file into a bundle.
 */

export type PseudoLocale = 'en-XA' | 'ar-XB';
export type LocaleTag = SupportedLocale | PseudoLocale;

export interface LocaleInfo<Tag extends LocaleTag = LocaleTag> {
  tag: Tag;
  /**
   * The tag handed to `Intl` for plural rules, numbers and dates. A pseudo-locale
   * borrows the language it imitates.
   */
  intl: string;
  /** Right-to-left: `<html dir="rtl">` and a mirrored layout. */
  rtl: boolean;
  /**
   * A machine-drafted catalog no native reader has reviewed yet. The picker
   * says so ("Español (beta)"); remove the flag only when a reviewer signs it
   * off (docs/dev/translations.md).
   */
  beta: boolean;
  load: () => Promise<Catalog>;
}

// `Complete` is what makes a missing key a type error here: the JSON a loader
// returns must have every key `en.json` has.
type Complete = Record<keyof typeof en, string>;

export const LOCALES: { [Tag in SupportedLocale]: LocaleInfo<Tag> } = {
  en: {
    tag: 'en',
    intl: 'en',
    rtl: false,
    beta: false,
    load: async (): Promise<Complete> => (await import('./en.json')).default,
  },
  es: {
    tag: 'es',
    intl: 'es',
    rtl: false,
    beta: true,
    load: async (): Promise<Complete> => (await import('./es.json')).default,
  },
  ar: {
    tag: 'ar',
    intl: 'ar',
    rtl: true,
    beta: true,
    load: async (): Promise<Complete> => (await import('./ar.json')).default,
  },
};

/**
 * Generated from `en.json` when chosen, so there is nothing to keep in step:
 * `en-XA` is accented and about 40% longer, `ar-XB` forces right-to-left runs.
 * For tests and for looking at the layout; see `lib/i18n/pseudo.ts`.
 */
export const PSEUDO_LOCALES: { [Tag in PseudoLocale]: LocaleInfo<Tag> & { name: string } } = {
  'en-XA': {
    tag: 'en-XA',
    name: 'Pseudo-locale: accented, longer',
    intl: 'en',
    rtl: false,
    beta: false,
    load: async () => pseudoCatalog((await import('./en.json')).default, 'en-XA'),
  },
  'ar-XB': {
    tag: 'ar-XB',
    name: 'Pseudo-locale: forced right-to-left',
    intl: 'ar',
    rtl: true,
    beta: false,
    load: async () => pseudoCatalog((await import('./en.json')).default, 'ar-XB'),
  },
};

interface BuildEnv {
  MODE?: string;
  VITE_OCI_PSEUDO_LOCALES?: string;
}

/**
 * Pseudo-locales exist outside production builds, and in a production build
 * only when it was made with `VITE_OCI_PSEUDO_LOCALES=1` (the browser tests
 * run against one).
 */
export function pseudoLocalesAvailable(env: BuildEnv = import.meta.env): boolean {
  return env.MODE !== 'production' || env.VITE_OCI_PSEUDO_LOCALES === '1';
}

export function isPseudoLocale(tag: string): tag is PseudoLocale {
  return tag in PSEUDO_LOCALES;
}

export function isRealLocale(tag: string): tag is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

export function localeInfo(tag: LocaleTag): LocaleInfo {
  return isPseudoLocale(tag) ? PSEUDO_LOCALES[tag] : LOCALES[tag];
}

/**
 * What a person may choose here: English, the languages the instance enabled
 * (in registry order), and the pseudo-locales where they are available.
 */
export function availableLocales(
  enabled: readonly string[] | null | undefined,
  options: { pseudo?: boolean } = {},
): LocaleTag[] {
  const pseudo = options.pseudo ?? pseudoLocalesAvailable();
  const real = SUPPORTED_LOCALES.filter(
    (tag) => tag === 'en' || (enabled ?? []).includes(tag),
  ) as LocaleTag[];
  return pseudo ? [...real, ...(Object.keys(PSEUDO_LOCALES) as PseudoLocale[])] : real;
}
