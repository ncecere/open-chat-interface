import { Link, useLocation } from '@tanstack/react-router';
import {
  Archive,
  ArrowLeft,
  Boxes,
  Cpu,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Mail,
  Palette,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { SkipLink } from '~/components/layout/skip-link';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

const NAV_SECTIONS = [
  {
    label: 'Instance',
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/branding', label: 'Branding', icon: Palette },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/invites', label: 'Invitations', icon: Mail },
      { to: '/admin/sso', label: 'Auth & SSO', icon: ShieldCheck },
    ],
  },
  {
    label: 'Models',
    items: [
      { to: '/admin/providers', label: 'Providers & Keys', icon: KeyRound },
      { to: '/admin/models', label: 'Model catalog', icon: Cpu },
    ],
  },
  /**
   * What people are allowed to do, kept apart from where things are wired up.
   * Storage appears in both: the allowance belongs here, the S3 connection
   * belongs under Platform.
   */
  {
    label: 'Governance',
    items: [
      { to: '/admin/quotas', label: 'Usage quotas', icon: Gauge },
      { to: '/admin/storage-limits', label: 'Storage limits', icon: HardDrive },
      { to: '/admin/rate-limits', label: 'Rate limits', icon: Timer },
      { to: '/admin/retention', label: 'Retention', icon: Archive },
    ],
  },
  {
    label: 'Platform',
    items: [
      { to: '/admin/search', label: 'Search', icon: Search },
      { to: '/admin/storage', label: 'Storage', icon: Boxes },
      { to: '/admin/maintenance', label: 'Maintenance', icon: Wrench },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
] as const;

export function AdminLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div className="flex h-dvh overflow-hidden">
      <SkipLink />
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] bg-[image:var(--sidebar-gradient)]">
        <div className="flex h-14 items-center px-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to Chat
            </Link>
          </Button>
        </div>

        <div className="px-4 pb-3">
          <p className="text-sm font-semibold">Administration</p>
        </div>

        <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mb-4">
              <p className="px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {section.label}
              </p>
              {section.items.map((item) => {
                const active =
                  'exact' in item && item.exact
                    ? pathname === item.to
                    : pathname.startsWith(item.to);

                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      'mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs
            keyboard access per WCAG 2.1.1, and this doubles as the skip-link target */}
        <div id="main-content" tabIndex={0} className="scrollbar-thin h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-8 py-10">{children}</div>
        </div>
      </main>
    </div>
  );
}
