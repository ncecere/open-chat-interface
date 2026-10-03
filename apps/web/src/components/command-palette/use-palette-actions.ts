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
import { useTheme } from '~/providers/theme-provider';
import type { CommandPaletteProps, PaletteGroup } from './types';

/** Build role-aware commands from the same navigation catalogue as the sidebar. */
export function usePaletteActions({
  sidebarOpen,
  onSidebarOpenChange,
}: Pick<CommandPaletteProps, 'sidebarOpen' | 'onSidebarOpenChange'>) {
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const { resolvedTheme, setTheme } = useTheme();
  return useMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [
      {
        id: 'chat',
        label: 'Chat',
        items: [
          {
            id: 'new-chat',
            label: 'New chat',
            keywords: 'start conversation home',
            icon: Plus,
            onSelect: () => navigate({ to: '/' }),
          },
          {
            id: 'history',
            label: 'Manage chat history',
            keywords: 'threads archive conversations',
            icon: History,
            onSelect: () => navigate({ to: '/settings/history' }),
          },
          {
            id: 'models',
            label: 'View all available models',
            keywords: 'ai providers',
            icon: Sparkles,
            onSelect: () => navigate({ to: '/settings/models' }),
          },
          {
            id: 'attachments',
            label: 'View all uploaded attachments',
            keywords: 'files uploads',
            icon: Paperclip,
            onSelect: () => navigate({ to: '/settings/attachments' }),
          },
        ],
      },
      {
        id: 'settings',
        label: 'Settings',
        items: [
          {
            id: 'account',
            label: 'Account settings',
            keywords: 'profile preferences',
            icon: Settings,
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'customize',
            label: 'Customize appearance',
            keywords: 'fonts density theme code wrap',
            icon: SlidersHorizontal,
            onSelect: () => navigate({ to: '/settings/customization' }),
          },
          {
            id: 'shortcuts',
            label: 'Show keyboard shortcuts',
            keywords: 'hotkeys commands',
            icon: Keyboard,
            // Listed in the Keyboard Shortcuts card beside every settings page.
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'toggle-theme',
            label: `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`,
            keywords: 'toggle appearance color mode',
            icon: resolvedTheme === 'dark' ? Palette : MoonStar,
            onSelect: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
          },
          {
            id: 'toggle-sidebar',
            label: `${sidebarOpen ? 'Close' : 'Open'} sidebar`,
            keywords: 'toggle collapse navigation',
            icon: ChevronsLeftRight,
            onSelect: () => onSidebarOpenChange(!sidebarOpen),
          },
        ],
      },
    ];

    // Auditors may read every admin page, so they get the same destinations.
    if (currentUser?.user.role === 'admin' || currentUser?.user.role === 'auditor') {
      groups.push({
        id: 'admin',
        label: 'Admin',
        items: [
          {
            id: 'admin-dashboard',
            label: 'Open admin dashboard',
            keywords: 'administration users providers quotas',
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
  }, [currentUser?.user.role, navigate, onSidebarOpenChange, resolvedTheme, setTheme, sidebarOpen]);
}
