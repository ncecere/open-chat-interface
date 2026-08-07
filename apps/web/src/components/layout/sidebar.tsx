import { Link } from '@tanstack/react-router';
import { PanelLeft, Search, UserRoundPlus } from 'lucide-react';
import { Wordmark } from '~/components/brand/wordmark';
import { UserMenu } from '~/components/layout/user-menu';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

interface SidebarProps {
  appName?: string;
  open: boolean;
  onToggle: () => void;
}

export function Sidebar({ appName, open, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        'flex h-dvh w-64 shrink-0 flex-col bg-[image:var(--sidebar-gradient)]',
        'transition-[margin] duration-200 ease-out',
        open ? 'ml-0' : '-ml-64',
      )}
    >
      <div className="flex h-14 items-center px-3">
        <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="Toggle sidebar">
          <PanelLeft />
        </Button>
        <Link to="/" className="min-w-0 flex-1 px-1 text-center">
          <Wordmark name={appName} className="block truncate" />
        </Link>
        <span className="size-8" />
      </div>

      <div className="px-3 pb-2">
        <Button variant="primary" className="h-9 w-full font-semibold">
          New Chat
        </Button>
      </div>

      <div className="relative px-3">
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          placeholder="Search your threads..."
          aria-label="Search your threads"
          className="h-11 w-full bg-transparent pl-8 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>

      <div className="mx-3 h-px bg-[var(--border-subtle)]" />

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3">
        <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
          Your conversations will appear here.
        </p>
      </nav>

      <div className="flex items-center gap-1 p-2">
        <div className="min-w-0 flex-1">
          <UserMenu />
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="New profile">
          <UserRoundPlus />
        </Button>
      </div>
    </aside>
  );
}
