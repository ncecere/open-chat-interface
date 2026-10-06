import { Link, Outlet, useLocation, useRouteContext } from '@tanstack/react-router';
import { ArrowLeft, Eye, Menu } from 'lucide-react';
import { useState } from 'react';
import {
  AdminAccessProvider,
  type AdminRole,
  READ_ONLY_MESSAGE,
} from '~/components/admin/admin-access';
import { UnsavedChangesGuard } from '~/components/admin/unsaved-changes';
import { ReadOnlyBanner } from '~/components/layout/read-only-banner';
import { SkipLink } from '~/components/layout/skip-link';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { RevealWhenLoaded } from '~/components/ui/reveal-when-loaded';
import {
  ADMIN_OVERVIEW,
  type AdminNavItem,
  findActiveAdminNav,
  isAdminNavItemActive,
  NAV_SECTIONS,
} from '~/lib/admin-navigation';
import { cn } from '~/lib/utils';

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: AdminNavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isAdminNavItemActive(pathname, item.to);
  return (
    <Link
      to={item.to}
      // Overview must not claim every nested admin page as its own.
      activeOptions={{ exact: item.to === ADMIN_OVERVIEW.to, includeSearch: false }}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
      )}
    >
      <item.icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** The grouped page list, shared by the desktop sidebar and the mobile drawer. */
function AdminNavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Administration" className="flex flex-col gap-3">
      <NavLink item={ADMIN_OVERVIEW} pathname={pathname} onNavigate={onNavigate} />
      {NAV_SECTIONS.map((section) => {
        const headingId = `admin-nav-${section.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
        return (
          <div key={section.label}>
            <p
              id={headingId}
              className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
            >
              {section.label}
            </p>
            <ul aria-labelledby={headingId} className="flex flex-col gap-px">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink item={item} pathname={pathname} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function BackToChat() {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/">
        <ArrowLeft aria-hidden="true" />
        Back to chat
      </Link>
    </Button>
  );
}

function sessionRole(context: unknown): AdminRole {
  const role = (context as { session?: { user?: { role?: string } } } | undefined)?.session?.user
    ?.role;
  // The router guard admits only admins and auditors; anything else is
  // treated as read-only rather than trusted with write controls.
  return role === 'admin' ? 'admin' : 'auditor';
}

export function AdminLayout() {
  const { pathname } = useLocation();
  const role = sessionRole(useRouteContext({ strict: false }));
  const [navOpen, setNavOpen] = useState(false);
  const [navPathname, setNavPathname] = useState(pathname);
  const current = findActiveAdminNav(pathname);

  // Close the drawer once navigation lands, including history navigation.
  if (navPathname !== pathname) {
    setNavPathname(pathname);
    setNavOpen(false);
  }

  return (
    <AdminAccessProvider role={role}>
      <UnsavedChangesGuard>
        <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
          <SkipLink />

          <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] bg-[image:var(--sidebar-gradient)] lg:flex">
            <div className="flex h-14 shrink-0 items-center px-3">
              <BackToChat />
            </div>
            <div className="px-4 pb-3">
              <p className="text-sm font-semibold">Administration</p>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              <AdminNavList pathname={pathname} />
            </div>
          </aside>

          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-2 lg:hidden">
            <Dialog open={navOpen} onOpenChange={setNavOpen}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open admin navigation"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(true)}
              >
                <Menu aria-hidden="true" />
              </Button>
              {navOpen && (
                <DialogContent
                  className={cn(
                    'left-0 top-0 flex h-dvh w-[min(20rem,85vw)] max-w-none translate-x-0 translate-y-0 flex-col',
                    'rounded-none rounded-r-2xl border-y-0 border-l-0 p-0',
                  )}
                >
                  <div className="flex h-14 shrink-0 items-center px-3 pr-12">
                    <BackToChat />
                  </div>
                  <div className="px-4 pb-3">
                    <DialogTitle className="text-sm font-semibold">Administration</DialogTitle>
                    <DialogDescription className="sr-only">
                      Choose an administration page.
                    </DialogDescription>
                  </div>
                  <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                    <AdminNavList pathname={pathname} onNavigate={() => setNavOpen(false)} />
                  </div>
                </DialogContent>
              )}
            </Dialog>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {current?.section?.label ?? 'Administration'}
              </p>
              {/* Every admin page is in the menu, so an address that matches
                  none of it is the not-found page, not Overview (#273). */}
              <p className="truncate text-sm font-semibold">
                {current?.item.label ?? 'Page not found'}
              </p>
            </div>
          </header>

          <main className="min-h-0 min-w-0 flex-1">
            {/* Positioned so absolutely placed descendants (such as Radix Select's hidden
              native select) stay inside it instead of widening the page on phones. */}
            <div
              id="main-content"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access per WCAG 2.1.1, and this doubles as the skip-link target
              tabIndex={0}
              className="scrollbar-thin relative h-full overflow-y-auto"
            >
              <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
                {role === 'auditor' && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-6 flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/45 px-4 py-3 text-sm text-[var(--text-secondary)]"
                  >
                    <Eye
                      className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                      aria-hidden="true"
                    />
                    <p>{READ_ONLY_MESSAGE}</p>
                  </div>
                )}
                {/* Read-only maintenance mode (v0.11): why the forms are off; an
                  administrator turns it off on System health. */}
                <ReadOnlyBanner className="mb-6 rounded-xl border" />
                {/* Shown once its first data is in, not section by section (#104). */}
                <RevealWhenLoaded resetKey={pathname}>
                  <Outlet />
                </RevealWhenLoaded>
              </div>
            </div>
          </main>
        </div>
      </UnsavedChangesGuard>
    </AdminAccessProvider>
  );
}
