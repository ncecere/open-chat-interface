import { useNavigate } from '@tanstack/react-router';
import {
  ChevronsLeftRight,
  History,
  Keyboard,
  MoonStar,
  Palette,
  Paperclip,
  Plus,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/use-current-user';
import { NAV_SECTIONS } from '~/lib/admin-navigation';
import { focusComposerSoon, touchOnly } from '~/lib/focus-after-navigation';
import { useT } from '~/lib/i18n';
import { shortcutKeys } from '~/lib/keyboard-shortcuts';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';
import { useTheme } from '~/providers/theme-provider';
import type { CommandPaletteProps, PaletteGroup } from './types';

/** Build role-aware commands from the same navigation catalogue as the sidebar. */
export function usePaletteActions({
  sidebarOpen,
  onSidebarOpenChange,
}: Pick<CommandPaletteProps, 'sidebarOpen' | 'onSidebarOpenChange'>) {
  const t = useT();
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const { resolvedTheme, setTheme } = useTheme();
  const { setTemporary } = useTemporaryChat();
  return useMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [
      {
        id: 'chat',
        label: t('palette.group.chat'),
        items: [
          {
            id: 'new-chat',
            label: t('palette.action.newChat'),
            keywords: t('palette.keywords.newChat'),
            icon: Plus,
            shortcut: shortcutKeys('new-chat'),
            // The cursor goes to the new chat's message box once the palette
            // has closed, not back to whatever opened it (#251).
            keepFocusOnClose: !touchOnly(),
            onSelect: async () => {
              // An ordinary chat, like the sidebar button (#340).
              setTemporary(false);
              await navigate({ to: '/' });
              focusComposerSoon();
            },
          },
          {
            id: 'history',
            label: t('palette.action.history'),
            keywords: t('palette.keywords.history'),
            icon: History,
            onSelect: () => navigate({ to: '/settings/history' }),
          },
          {
            id: 'models',
            label: t('palette.action.models'),
            keywords: t('palette.keywords.models'),
            icon: Sparkles,
            onSelect: () => navigate({ to: '/settings/models' }),
          },
          {
            id: 'attachments',
            label: t('palette.action.attachments'),
            keywords: t('palette.keywords.attachments'),
            icon: Paperclip,
            onSelect: () => navigate({ to: '/settings/attachments' }),
          },
        ],
      },
      {
        id: 'settings',
        label: t('palette.group.settings'),
        items: [
          {
            id: 'account',
            label: t('palette.action.account'),
            keywords: t('palette.keywords.account'),
            icon: Settings,
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'customize',
            label: t('palette.action.customize'),
            keywords: t('palette.keywords.customize'),
            icon: SlidersHorizontal,
            onSelect: () => navigate({ to: '/settings/customization' }),
          },
          {
            id: 'shortcuts',
            label: t('palette.action.shortcuts'),
            keywords: t('palette.keywords.shortcuts'),
            icon: Keyboard,
            // Listed in the Keyboard Shortcuts card beside every settings page.
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'toggle-theme',
            label: t(
              resolvedTheme === 'dark' ? 'palette.action.themeLight' : 'palette.action.themeDark',
            ),
            keywords: t('palette.keywords.theme'),
            icon: resolvedTheme === 'dark' ? Palette : MoonStar,
            onSelect: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
          },
          {
            id: 'toggle-sidebar',
            label: t(sidebarOpen ? 'palette.action.sidebarClose' : 'palette.action.sidebarOpen'),
            keywords: t('palette.keywords.sidebar'),
            icon: ChevronsLeftRight,
            shortcut: shortcutKeys('toggle-sidebar'),
            onSelect: () => onSidebarOpenChange(!sidebarOpen),
          },
        ],
      },
    ];

    // Auditors may read every admin page, so they get the same destinations.
    if (currentUser?.user.role === 'admin' || currentUser?.user.role === 'auditor') {
      groups.push({
        id: 'admin',
        label: t('palette.group.admin'),
        items: [
          {
            id: 'admin-dashboard',
            label: t('palette.action.adminDashboard'),
            keywords: t('palette.keywords.adminDashboard'),
            icon: Shield,
            onSelect: () => navigate({ to: '/admin' }),
          },
          // Built from the sidebar's own list, so a page added there is
          // reachable here without anybody remembering to add it twice.
          ...NAV_SECTIONS.flatMap((section) =>
            section.items.map((item) => ({
              id: `admin-${item.to}`,
              label: item.label,
              keywords: `admin administration ${section.label}`,
              icon: item.icon,
              onSelect: () => navigate({ to: item.to }),
            })),
          ),
        ],
      });
    }

    return groups;
  }, [
    currentUser?.user.role,
    navigate,
    onSidebarOpenChange,
    resolvedTheme,
    setTemporary,
    setTheme,
    sidebarOpen,
    t,
  ]);
}
