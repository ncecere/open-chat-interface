import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { useCurrentUser } from '~/hooks/use-current-user';
import { availableLocales, type LocaleTag, pseudoLocalesAvailable } from '~/locales';
import { resolveLocale } from './resolve';
import {
  activateLocale,
  getI18nState,
  type I18nState,
  initialLocale,
  PSEUDO_STORAGE_KEY,
  rememberLocale,
  subscribeI18n,
  type Translate,
} from './state';

/** Re-renders the component whenever the app's language changes. */
function useI18nState(): I18nState {
  return useSyncExternalStore(subscribeI18n, getI18nState, getI18nState);
}

/**
 * The translate function for components: `const t = useT(); t('some.key', { n })`.
 * It is a new function when the language changes, so it is safe in a hook's
 * dependency list, and the component renders again in the new language.
 */
export function useT(): Translate {
  return useI18nState().t;
}

export interface LocaleContextValue {
  locale: LocaleTag;
  dir: 'ltr' | 'rtl';
  /** What this person may choose now: English, the enabled languages, and pseudo-locales in test builds. */
  available: LocaleTag[];
  /** The instance's default language, or null when it follows the browser. */
  instanceDefault: string | null;
  /** Pseudo-locales are chosen per device, never saved to the server. */
  setPseudoLocale: (tag: LocaleTag | null) => void;
}

const defaultValue: LocaleContextValue = {
  locale: 'en',
  dir: 'ltr',
  available: ['en'],
  instanceDefault: null,
  setPseudoLocale: () => undefined,
};

const LocaleContext = createContext<LocaleContextValue>(defaultValue);

/** The current language, its direction and the languages on offer. */
export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  const { locale, dir } = useI18nState();
  return useMemo(() => ({ ...value, locale, dir }), [value, locale, dir]);
}

function browserLanguages(): string[] {
  return typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [navigator.language])];
}

function readPseudoChoice(): string | null {
  try {
    return localStorage.getItem(PSEUDO_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Decides the language and keeps `<html lang dir>` in step with it.
 *
 * Waits for the person's saved language and the instance's setting before
 * choosing, staying in the language shown last time meanwhile, so a Spanish
 * reader does not see English, then Spanish. When the settings cannot be read
 * (an outage) it decides with what it has.
 *
 * Renders nothing until a catalog has been loaded (every catalog, English
 * included, is a dynamic import): `main.tsx` awaits the first load before it
 * renders, and this is the net under that for any other entry point, so the
 * app is never shown as bare keys. If the load fails altogether the app is
 * shown anyway (English, then the keys) rather than staying blank.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const status = useAuthStatus();
  const me = useCurrentUser();
  const [pseudoChoice, setPseudoChoiceState] = useState<string | null>(readPseudoChoice);
  const setPseudoChoice = useCallback((tag: LocaleTag | null) => {
    try {
      if (tag) localStorage.setItem(PSEUDO_STORAGE_KEY, tag);
      else localStorage.removeItem(PSEUDO_STORAGE_KEY);
    } catch {
      // Storage blocked: the choice lasts until the page is closed.
    }
    setPseudoChoiceState(tag);
  }, []);

  const language = status.data?.language;
  const saved = me.data?.preferences?.locale ?? null;
  const ready = !me.isPending && (!status.isPending || status.isError);

  const locale = useMemo(
    () =>
      ready
        ? resolveLocale({
            saved,
            instanceDefault: language?.default ?? null,
            enabled: language?.enabled,
            browser: browserLanguages(),
            pseudoChoice,
          })
        : null,
    [ready, saved, language?.default, language?.enabled, pseudoChoice],
  );

  const { ready: loaded } = useI18nState();
  useEffect(() => {
    if (!loaded) void activateLocale(initialLocale());
  }, [loaded]);

  useEffect(() => {
    if (!locale) return;
    void activateLocale(locale).then(() => {
      if (getI18nState().locale === locale) rememberLocale(locale);
    });
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      ...defaultValue,
      available: availableLocales(language?.enabled, { pseudo: pseudoLocalesAvailable() }),
      instanceDefault: language?.default ?? null,
      setPseudoLocale: setPseudoChoice,
    }),
    [language?.enabled, language?.default, setPseudoChoice],
  );

  return <LocaleContext.Provider value={value}>{loaded ? children : null}</LocaleContext.Provider>;
}
