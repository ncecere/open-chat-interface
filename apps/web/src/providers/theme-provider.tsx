import { COLOR_THEMES, type ColorTheme, type ThemeMode } from '@oci/shared';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

const THEME_STORAGE_KEY = 'oci.theme';
const CODE_WRAP_STORAGE_KEY = 'oci.codeWrap';
/**
 * The instance color theme is administrator-owned, but caching it avoids a
 * flash of the default accent before /auth/status resolves.
 */
const COLOR_THEME_STORAGE_KEY = 'oci.colorTheme';
/**
 * The administrator's default light/dark theme, cached for the same reason.
 * Kept apart from THEME_STORAGE_KEY, which only ever holds a person's own
 * explicit choice, so the instance default never masquerades as one.
 */
const INSTANCE_THEME_STORAGE_KEY = 'oci.instanceTheme';
/** Used before the instance default is known and when nothing is cached. */
const FALLBACK_THEME: ThemeMode = 'dark';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  /** Wrap long lines in code blocks instead of scrolling them sideways. */
  codeWrap: boolean;
  colorTheme: ColorTheme;
  setTheme: (theme: ThemeMode) => void;
  setCodeWrap: (enabled: boolean) => void;
  setColorTheme: (theme: ColorTheme) => void;
  /**
   * The instance default from branding. Applies only while this person has
   * not chosen a theme; an explicit choice through setTheme always wins.
   */
  setInstanceDefaultTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function asThemeMode(value: string | null): ThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

function readStoredTheme(): ThemeMode | null {
  return asThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
}

function readInstanceTheme(): ThemeMode {
  return asThemeMode(localStorage.getItem(INSTANCE_THEME_STORAGE_KEY)) ?? FALLBACK_THEME;
}

function readStoredColorTheme(): ColorTheme {
  const stored = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
  return COLOR_THEMES.includes(stored as ColorTheme) ? (stored as ColorTheme) : 'neutral';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [userTheme, setUserTheme] = useState<ThemeMode | null>(readStoredTheme);
  const [instanceTheme, setInstanceTheme] = useState<ThemeMode>(readInstanceTheme);
  const theme = userTheme ?? instanceTheme;
  const [codeWrap, setCodeWrapState] = useState(
    () => localStorage.getItem(CODE_WRAP_STORAGE_KEY) === 'true',
  );
  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(systemTheme);
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(readStoredColorTheme);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) =>
      setSystemPreference(event.matches ? 'dark' : 'light');
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const resolvedTheme = theme === 'system' ? systemPreference : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.classList.toggle('light', resolvedTheme === 'light');
    root.classList.toggle('code-wrap', codeWrap);
    root.dataset.colorTheme = colorTheme;
  }, [resolvedTheme, codeWrap, colorTheme]);

  const setTheme = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setUserTheme(next);
  }, []);

  const setInstanceDefaultTheme = useCallback((next: ThemeMode) => {
    localStorage.setItem(INSTANCE_THEME_STORAGE_KEY, next);
    setInstanceTheme(next);
  }, []);

  const setCodeWrap = useCallback((enabled: boolean) => {
    localStorage.setItem(CODE_WRAP_STORAGE_KEY, String(enabled));
    setCodeWrapState(enabled);
  }, []);

  const setColorTheme = useCallback((next: ColorTheme) => {
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, next);
    setColorThemeState(next);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      codeWrap,
      colorTheme,
      setTheme,
      setCodeWrap,
      setColorTheme,
      setInstanceDefaultTheme,
    }),
    [
      theme,
      resolvedTheme,
      codeWrap,
      colorTheme,
      setTheme,
      setCodeWrap,
      setColorTheme,
      setInstanceDefaultTheme,
    ],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
