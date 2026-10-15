import {
  isPseudoLocale,
  isRealLocale,
  type LocaleTag,
  localeInfo,
  pseudoLocalesAvailable,
} from '~/locales';
import type { Catalog, MessageKey } from './catalog';
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
  /**
   * The first load has finished, successfully or not. Until then `t` can only
   * return keys (no catalog is in memory yet), so nothing renders; see
   * `I18nProvider` and `main.tsx`.
   */
  ready: boolean;
}

export const LOCALE_STORAGE_KEY = 'oci.locale';
export const PSEUDO_STORAGE_KEY = 'oci.pseudoLocale';

// Kept on `globalThis` so a re-evaluated copy of this module (Vite hot reload,
// or `vi.resetModules()` in a test) finds the catalogs already loaded instead
// of showing keys until the next `activateLocale`. Nothing else is shared.
const REGISTRY = '__ociI18nCatalogs';
const registry = globalThis as unknown as { [REGISTRY]?: Map<LocaleTag, Catalog> };
const catalogs = registry[REGISTRY] ?? new Map<LocaleTag, Catalog>();
registry[REGISTRY] = catalogs;
let settled = catalogs.has('en');
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
  const english = catalogs.get('en')?.[key];
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
    ready: settled,
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

/** Fetches one catalog once; a failure (offline, a stale chunk after a deploy) is `undefined`, never a throw. */
async function load(tag: LocaleTag): Promise<Catalog | undefined> {
  const loaded = catalogs.get(tag);
  if (loaded) return loaded;
  try {
    const catalog = await localeInfo(tag).load();
    catalogs.set(tag, catalog);
    return catalog;
  } catch {
    return undefined;
  }
}

/**
 * Shows the app in `locale`. Every catalog is a dynamic import, English too,
 * so this is what makes strings exist at all: `main.tsx` awaits it before the
 * first render. The language's catalog is fetched together with English (the
 * fallback for a key it lacks) and the switch is made in one step, so nothing
 * renders half in the old language or as bare keys. When two switches overlap
 * the last one asked for wins whichever load finishes first.
 *
 * A catalog that cannot be loaded never throws: a language already showing
 * stays as it was; at the first load the app falls back to English, and when
 * English cannot be fetched either `translate()` returns the key.
 */
export async function activateLocale(locale: LocaleTag): Promise<void> {
  const ticket = ++latest;
  if (!isRealLocale(locale) && !isPseudoLocale(locale)) return;
  const [own] = await Promise.all([load(locale), locale === 'en' ? undefined : load('en')]);
  // A newer switch is in charge now and will finish the job.
  if (ticket !== latest) return;

  let target: LocaleTag = locale;
  if (!own) target = catalogs.has(state.locale) ? state.locale : 'en';
  if (state.locale !== target || !state.ready) {
    settled = true;
    state = makeState(target);
    setFormatLocale(state.intl);
    applyToDocument(state);
    for (const listener of listeners) listener();
    return;
  }
  // Nothing to switch, but the attributes may be unset on a first call.
  applyToDocument(state);
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
