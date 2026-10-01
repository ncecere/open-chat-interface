import type { LinkProps } from '@tanstack/react-router';
import {
  Activity,
  Archive,
  Boxes,
  ChartColumn,
  Cpu,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  Mails,
  Megaphone,
  Palette,
  ScrollText,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Timer,
  UserCog,
  Users,
  Wrench,
} from 'lucide-react';

/** Every static admin route the router knows about, so a typo fails typecheck. */
export type AdminRoutePath = Extract<NonNullable<LinkProps['to']>, `/admin${string}`>;

export interface AdminNavItem {
  to: AdminRoutePath;
  label: string;
  icon: LucideIcon;
}

export interface AdminNavSection {
  label: string;
  items: readonly AdminNavItem[];
}

// Shared by the sidebar and command palette without importing the admin layout.
// Items are plain records, so a later phase can merge or replace pages by
// editing this list alone.

/** Shown first and outside any group. */
export const ADMIN_OVERVIEW: AdminNavItem = {
  to: '/admin',
  label: 'Overview',
  icon: LayoutDashboard,
};

export const NAV_SECTIONS: readonly AdminNavSection[] = [
  {
    label: 'People',
    items: [
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/invites', label: 'Invitations', icon: Mail },
      { to: '/admin/rate-limits', label: 'Rate limits', icon: Timer },
      { to: '/admin/storage-limits', label: 'Storage limits', icon: HardDrive },
    ],
  },
  {
    label: 'Models',
    items: [
      { to: '/admin/providers', label: 'Providers & keys', icon: KeyRound },
      { to: '/admin/models', label: 'Model catalog', icon: Cpu },
      { to: '/admin/quotas', label: 'Usage budgets', icon: Gauge },
    ],
  },
  {
    label: 'Sign-in & security',
    items: [
      { to: '/admin/settings/authentication', label: 'Authentication', icon: UserCog },
      { to: '/admin/sso', label: 'Single sign-on', icon: ShieldCheck },
      { to: '/admin/settings/email', label: 'Email delivery', icon: Send },
      { to: '/admin/policies', label: 'Acceptable use', icon: FileText },
    ],
  },
  {
    label: 'Data & storage',
    items: [
      { to: '/admin/storage', label: 'Storage', icon: Boxes },
      { to: '/admin/retention', label: 'Retention', icon: Archive },
      { to: '/admin/maintenance', label: 'Maintenance', icon: Wrench },
      { to: '/admin/health', label: 'Health', icon: Activity },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/admin/usage', label: 'Usage', icon: ChartColumn },
      { to: '/admin/reports', label: 'Reports', icon: Mails },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
  {
    label: 'Appearance & features',
    items: [
      { to: '/admin/settings/general', label: 'General', icon: Settings },
      { to: '/admin/branding', label: 'Branding', icon: Palette },
      { to: '/admin/broadcasts', label: 'Announcements', icon: Megaphone },
      { to: '/admin/search', label: 'Web search', icon: Search },
    ],
  },
];

/**
 * Whether a nav item represents the current page.
 *
 * Overview only matches itself; every other item also matches its nested
 * paths (a user's detail page belongs to Users). Matching stops at a path
 * segment boundary, so `/admin/storage` never claims `/admin/storage-limits`.
 */
export function isAdminNavItemActive(pathname: string, to: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (to === ADMIN_OVERVIEW.to) return path === to;
  return path === to || path.startsWith(`${to}/`);
}

/** The item and group for the current page, preferring the most specific match. */
export function findActiveAdminNav(
  pathname: string,
): { item: AdminNavItem; section: AdminNavSection | null } | null {
  let best: { item: AdminNavItem; section: AdminNavSection | null } | null = null;
  const candidates: Array<{ item: AdminNavItem; section: AdminNavSection | null }> = [
    { item: ADMIN_OVERVIEW, section: null },
    ...NAV_SECTIONS.flatMap((section) => section.items.map((item) => ({ item, section }))),
  ];
  for (const candidate of candidates) {
    if (!isAdminNavItemActive(pathname, candidate.item.to)) continue;
    if (!best || candidate.item.to.length > best.item.to.length) best = candidate;
  }
  return best;
}
