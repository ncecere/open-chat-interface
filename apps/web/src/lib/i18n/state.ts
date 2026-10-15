import {
  isPseudoLocale,
  isRealLocale,
  type LocaleTag,
  localeInfo,
  pseudoLocalesAvailable,
} from '~/locales';
import { type Catalog, type MessageKey, sourceCatalog } from './catalog';
import { setFormatLocale } from './format';
import { formatMessage, isValidMessage, type MessageParams } from './message';

/**
 * Which language the app is showing, and the catalog that goes with it.
 *
 * A small store rather than React state, so `translate()` works anywhere (a
 * toast, an error message built in a hook, a document title) and React reads
 * it through `useSyncExternalStore` (`./react.ts`).
 */

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface I18nState {
  locale: LocaleTag;
  dir: 'ltr' | 'rtl';
  /** The `Intl` tag for this locale. */
  intl: string;
  t: Translate;
}

export const LOCALE_STORAGE_KEY = 'oci.locale';
export const PSEUDO_STORAGE_KEY = 'oci.pseudoLocale';

const catalogs = new Map<LocaleTag, Catalog>([['en', sourceCatalog]]);
const listeners = new Set<() => void>();
const warned = new Set<string>();

function warnOnce(key: string, what: string): void {
  if (import.meta.env.MODE !== 'development' || warned.has(`${what}:${key}`)) return;
  warned.add(`${what}:${key}`);
  console.warn(`[i18n] ${what}: ${key}`);
}

/**
 * Looks a key up in `locale`'s catalog, then in English, then falls back to
 * the key itself. A message that does not parse falls back the same way, so a
 * translator's slip shows English, never a blank or a crash.
 */
function translateIn(locale: LocaleTag, key: string, params?: MessageParams): string {
  const info = localeInfo(locale);
  const own = catalogs.get(locale)?.[key];
  const english = sourceCatalog[key];
  let message: string | undefined = own;
  if (message === undefined) {
    if (locale !== 'en') warnOnce(key, 'missing key');
    message = english;
  } else if (locale !== 'en' && !isValidMessage(message)) {
    warnOnce(key, 'invalid message');
    message = english;
  }
  if (message === undefined) {
    warnOnce(key, 'unknown key');
    return key;
  }
  return formatMessage(message, params, { locale: info.intl });
}

function makeState(locale: LocaleTag): I18nState {
  const info = localeInfo(locale);
  return {
    locale,
    dir: info.rtl ? 'rtl' : 'ltr',
    intl: info.intl,
    t: (key, params) => translateIn(locale, key, params),
  };
}

let state: I18nState = makeState('en');

export function getI18nState(): I18nState {
  return state;
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `<html lang dir>`: what assistive technology, the browser's hyphenation and CSS direction follow. */
function applyToDocument(next: I18nState): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = next.locale;
  document.documentElement.dir = next.dir;
}

let latest = 0;

/**
 * Shows the app in `locale`. The catalog is fetched first and the switch made
 * in one step, so nothing renders half in the old language. When two switches
 * overlap the last one asked for wins whichever load finishes first, and a
 * catalog that cannot be loaded (offline, a stale chunk after a deploy) leaves
 * the language as it was.
 */
export async function activateLocale(locale: LocaleTag): Promise<void> {
  const ticket = ++latest;
  const info = (isRealLocale(locale) || isPseudoLocale(locale)) && localeInfo(locale);
  if (!info) return;
  if (!catalogs.has(locale)) {
    try {
      catalogs.set(locale, await info.load());
    } catch {
      return;
    }
  }
  if (ticket !== latest || state.locale === locale) {
    // Still refresh the document: a first call may find the attributes unset.
    if (ticket === latest) applyToDocument(state);
    return;
  }
  state = makeState(locale);
  setFormatLocale(state.intl);
  applyToDocument(state);
  for (const listener of listeners) listener();
}

/** The non-React entry point: `translate('settings.language.title')`. */
export function translate(key: MessageKey, params?: MessageParams): string {
  return state.t(key, params);
}

/**
 * The language to start in, before the instance's settings and the person's
 * saved choice are known: what was shown last time on this device (so a
 * Spanish reader is not flashed English), else English. The browser's
 * languages are not used here because whether they apply depends on which
 * languages the instance enables.
 */
export function initialLocale(options: { pseudo?: boolean } = {}): LocaleTag {
  const pseudo = options.pseudo ?? pseudoLocalesAvailable();
  try {
    const chosen = localStorage.getItem(PSEUDO_STORAGE_KEY);
    if (pseudo && chosen && isPseudoLocale(chosen)) return chosen;
    const cached = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (cached && isRealLocale(cached)) return cached;
  } catch {
    // Storage blocked: start in English.
  }
  return 'en';
}

export function rememberLocale(locale: LocaleTag): void {
  try {
    if (isRealLocale(locale)) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Not worth failing for.
  }
}
