import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { SkipLink } from '~/components/layout/skip-link';
import { Button } from '~/components/ui/button';
import { NAV_SECTIONS } from '~/lib/admin-navigation';
import { cn } from '~/lib/utils';

export function AdminLayout() {
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
          <div className="mx-auto w-full max-w-5xl px-8 py-10">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
