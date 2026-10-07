import { Link, useNavigate } from '@tanstack/react-router';
import { PanelLeft, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Wordmark } from '~/components/brand/wordmark';
import { SidebarProjects } from '~/components/layout/sidebar-projects';
import { ThreadList } from '~/components/layout/thread-list';
import { ThreadSearchResults } from '~/components/layout/thread-search-results';
import { UserMenu } from '~/components/layout/user-menu';
import { Button } from '~/components/ui/button';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { useCreateThread } from '~/hooks/use-threads';
import { ariaKeyShortcuts } from '~/lib/keyboard-shortcuts';
import { loopTab } from '~/lib/tab-loop';
import { cn } from '~/lib/utils';

interface SidebarProps {
  open: boolean;
  mobile: boolean;
  onToggle: () => void;
}

export function Sidebar({ open, mobile, onToggle }: SidebarProps) {
  // Read here rather than threaded through the shell: the header needs the
  // logo and short name too, and the status query is already cached.
  const { data: status } = useAuthStatus();
  const branding = status?.branding;
  const [search, setSearch] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const createThread = useCreateThread();

  useEffect(() => {
    if (mobile && open) closeButtonRef.current?.focus();
  }, [mobile, open]);

  async function handleNewChat() {
    await navigate({ to: '/' });
    if (mobile) onToggle();
  }

  return (
    // The role switches with the responsive layout; aria-modal applies only to the mobile dialog.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: dynamic role and aria-modal are kept in sync
    <aside
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? true : undefined}
      aria-label={mobile ? 'Conversation sidebar' : undefined}
      aria-hidden={!open ? true : undefined}
      inert={!open ? true : undefined}
      // As a modal, Tab and Shift+Tab stay in it (#191).
      onKeyDown={mobile && open ? loopTab : undefined}
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex h-dvh w-full shrink-0 flex-col bg-[var(--bg-app)] bg-[image:var(--sidebar-gradient)]',
        'transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-64 lg:transition-[margin]',
        open ? 'translate-x-0 lg:ml-0' : '-translate-x-full lg:-ml-64 lg:translate-x-0',
      )}
    >
      <div className="flex h-14 items-center px-3">
        <Button
          ref={closeButtonRef}
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label="Close sidebar"
          aria-keyshortcuts={ariaKeyShortcuts('toggle-sidebar')}
        >
          <PanelLeft />
        </Button>
        {/* Mark and name sit beside the toggle (v0.10): centring them needed a
            spacer that left too little room for the full default name. */}
        <Link to="/" className="flex min-w-0 flex-1 items-center px-2">
          <Wordmark
            name={branding?.appName}
            shortName={branding?.shortName}
            logoUrl={branding?.logoUrl}
            compact
          />
        </Link>
      </div>

      <div className="hidden px-3 pb-2 lg:block">
        <Button
          variant="primary"
          className="h-9 w-full font-semibold"
          onClick={handleNewChat}
          disabled={createThread.isPending}
          aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
        >
          New Chat
        </Button>
      </div>

      <div className="relative px-3">
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && search) {
              event.stopPropagation();
              setSearch('');
            }
          }}
          placeholder="Search your threads..."
          aria-label="Search your threads"
          aria-describedby="thread-search-hint"
          className="h-11 w-full bg-transparent pl-8 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      <p id="thread-search-hint" className="sr-only">
        Searches titles and message text. Results appear below.
      </p>

      <div className="mx-3 h-px bg-[var(--border-subtle)]" />

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3">
        {search.trim() ? (
          <ThreadSearchResults query={search} />
        ) : (
          <>
            <SidebarProjects />
            <ThreadList />
          </>
        )}
      </nav>

      <div className="hidden items-center gap-1 p-2 lg:flex">
        <div className="min-w-0 flex-1">
          <UserMenu />
        </div>
      </div>

      <div className="flex items-center justify-between px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:hidden">
        <Button
          variant="accent"
          className="h-11 rounded-full px-5"
          onClick={handleNewChat}
          aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
        >
          New Chat
        </Button>
        <UserMenu compact />
      </div>
    </aside>
  );
}
