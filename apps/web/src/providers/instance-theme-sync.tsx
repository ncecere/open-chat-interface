import { useEffect } from 'react';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { useTheme } from '~/providers/theme-provider';

/**
 * Applies the administrator-selected color theme. `/auth/status` is public, so
 * this works on the login and public share pages too. Renders nothing.
 */
export function InstanceThemeSync() {
  const { data } = useAuthStatus();
  const { colorTheme, setColorTheme } = useTheme();
  const instanceTheme = data?.branding.colorTheme;

  useEffect(() => {
    if (instanceTheme && instanceTheme !== colorTheme) setColorTheme(instanceTheme);
  }, [instanceTheme, colorTheme, setColorTheme]);

  return null;
}
