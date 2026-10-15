import {
  availableLocales,
  isPseudoLocale,
  isRealLocale,
  type LocaleTag,
  pseudoLocalesAvailable,
} from '~/locales';

/**
 * The language to show, in this order:
 *
 *  1. a pseudo-locale chosen on this device (tests and layout work only);
 *  2. the person's saved language;
 *  3. the instance default (Admin → Branding);
 *  4. the browser's languages, matched to the enabled ones;
 *  5. English.
 *
 * Each of 2 and 3 counts only while the instance still enables it, so a person
 * whose language was switched off falls through to the next step without any
 * error, and their saved choice is kept in case it is switched on again.
 */
export interface ResolveInput {
  saved?: string | null;
  instanceDefault?: string | null;
  /** The languages the instance enabled; English is always available. */
  enabled?: readonly string[] | null;
  /** `navigator.languages`. */
  browser?: readonly string[];
  /** Whether pseudo-locales are offered; the build decides when omitted. */
  pseudo?: boolean;
  pseudoChoice?: string | null;
}

/** The first of the person's browser languages that is enabled, by tag, then by its language. */
export function matchBrowserLocale(
  browser: readonly string[],
  enabled: readonly string[],
): LocaleTag | null {
  const real = enabled.filter(isRealLocale);
  for (const raw of browser) {
    const tag = raw.toLowerCase();
    const exact = real.find((candidate) => candidate.toLowerCase() === tag);
    if (exact) return exact;
    const language = tag.split('-')[0];
    const byLanguage = real.find((candidate) => candidate.toLowerCase() === language);
    if (byLanguage) return byLanguage;
  }
  return null;
}

export function resolveLocale(input: ResolveInput): LocaleTag {
  const pseudo = input.pseudo ?? pseudoLocalesAvailable();
  if (pseudo && input.pseudoChoice && isPseudoLocale(input.pseudoChoice)) {
    return input.pseudoChoice;
  }
  const enabled = availableLocales(input.enabled, { pseudo: false });
  for (const candidate of [input.saved, input.instanceDefault]) {
    if (candidate && isRealLocale(candidate) && enabled.includes(candidate)) return candidate;
  }
  return matchBrowserLocale(input.browser ?? [], enabled) ?? 'en';
}
