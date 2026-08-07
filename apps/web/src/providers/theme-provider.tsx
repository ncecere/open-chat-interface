import type { ThemeMode } from '@oci/shared';
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

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  boringMode: boolean;
  setTheme: (theme: ThemeMode) => void;
  setBoringMode: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  const [boringMode, setBoringState] = useState(
    () => localStorage.getItem(BORING_STORAGE_KEY) === 'true',
  );
  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(systemTheme);

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
  }, [resolvedTheme, boringMode]);

  const setTheme = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setBoringMode = useCallback((enabled: boolean) => {
    localStorage.setItem(BORING_STORAGE_KEY, String(enabled));
    setBoringState(enabled);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, boringMode, setTheme, setBoringMode }),
    [theme, resolvedTheme, boringMode, setTheme, setBoringMode],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
