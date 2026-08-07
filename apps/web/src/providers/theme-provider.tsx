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
const BORING_STORAGE_KEY = 'oci.boring';
/**
 * The instance color theme is administrator-owned, but caching it avoids a
 * flash of the default accent before /auth/status resolves.
 */
const COLOR_THEME_STORAGE_KEY = 'oci.colorTheme';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  boringMode: boolean;
  colorTheme: ColorTheme;
  setTheme: (theme: ThemeMode) => void;
  setBoringMode: (enabled: boolean) => void;
  setColorTheme: (theme: ColorTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
}

function readStoredColorTheme(): ColorTheme {
  const stored = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
  return COLOR_THEMES.includes(stored as ColorTheme) ? (stored as ColorTheme) : 'neutral';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  const [boringMode, setBoringState] = useState(
    () => localStorage.getItem(BORING_STORAGE_KEY) === 'true',
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
    root.classList.toggle('boring', boringMode);
    root.dataset.colorTheme = colorTheme;
  }, [resolvedTheme, boringMode, colorTheme]);

  const setTheme = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setBoringMode = useCallback((enabled: boolean) => {
    localStorage.setItem(BORING_STORAGE_KEY, String(enabled));
    setBoringState(enabled);
  }, []);

  const setColorTheme = useCallback((next: ColorTheme) => {
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, next);
    setColorThemeState(next);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      boringMode,
      colorTheme,
      setTheme,
      setBoringMode,
      setColorTheme,
    }),
    [theme, resolvedTheme, boringMode, colorTheme, setTheme, setBoringMode, setColorTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
