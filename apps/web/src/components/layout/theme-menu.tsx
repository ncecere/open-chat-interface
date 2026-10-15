import { Link } from '@tanstack/react-router';
import { Monitor, Moon, Settings2, Sun } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { type MessageKey, useT } from '~/lib/i18n';
import { useTheme } from '~/providers/theme-provider';

const THEME_OPTIONS = [
  { value: 'light', label: 'shell.themeMenu.light', icon: Sun },
  { value: 'dark', label: 'shell.themeMenu.dark', icon: Moon },
  { value: 'system', label: 'shell.themeMenu.system', icon: Monitor },
] as const satisfies readonly { value: string; label: MessageKey; icon: unknown }[];

export function ThemeMenu() {
  const t = useT();
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('shell.themeMenu.label')}>
          <Settings2 />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('shell.themeMenu.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as (typeof THEME_OPTIONS)[number]['value'])}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon />
              <span className="flex-1">{t(option.label)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link to="/settings">{t('shell.themeMenu.allSettings')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
