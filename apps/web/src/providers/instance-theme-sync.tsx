import { useEffect } from 'react';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { useTheme } from '~/providers/theme-provider';

/**
 * Applies the administrator-selected color theme and default light/dark theme.
 * `/auth/status` is public, so this works on the login and public share pages
 * too. The default theme only shows for people who have not chosen their own;
 * the provider keeps an explicit choice in front of it. Renders nothing.
 */
export function InstanceThemeSync() {
  const { data } = useAuthStatus();
  const { colorTheme, setColorTheme, setInstanceDefaultTheme } = useTheme();
  const instanceTheme = data?.branding.colorTheme;
  const defaultTheme = data?.branding.defaultTheme;

  useEffect(() => {
    if (instanceTheme && instanceTheme !== colorTheme) setColorTheme(instanceTheme);
  }, [instanceTheme, colorTheme, setColorTheme]);

  useEffect(() => {
    if (defaultTheme) setInstanceDefaultTheme(defaultTheme);
  }, [defaultTheme, setInstanceDefaultTheme]);

  return null;
}
