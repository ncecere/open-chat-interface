import { Link } from '@tanstack/react-router';
import { History, PanelLeft, Plus, Search } from 'lucide-react';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

interface TopBarProps {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
}

/**
 * Thin band above the main panel, matching the reference layout. The band is
 * only a few pixels tall, so the controls it owns are rendered as pills that
 * hang below it over the panel.
 */
export function TopBar({ sidebarOpen, onOpenSidebar }: TopBarProps) {
  return (
    <header
      className={cn(
        'relative z-30 shrink-0',
        // The band only exists to bridge the gap beside the sidebar. With the
        // sidebar collapsed the panel runs to the top of the viewport.
        sidebarOpen ? 'h-[0.9375rem] bg-[var(--bg-app)]' : 'h-0',
      )}
    >
      {!sidebarOpen && (
        <div className="absolute left-2 top-6 flex items-center gap-0.5 rounded-xl bg-[var(--bg-pill)] p-1">
          <Button variant="ghost" size="icon-sm" onClick={onOpenSidebar} aria-label="Open sidebar">
            <PanelLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Search threads">
            <Search />
          </Button>
          <Button variant="ghost" size="icon-sm" asChild aria-label="New chat">
            <Link to="/">
              <Plus />
            </Link>
          </Button>
        </div>
      )}

      <div className="absolute right-2 top-6 flex items-center gap-0.5 rounded-xl bg-[var(--bg-pill)] p-1">
        <Button variant="ghost" size="icon-sm" aria-label="Temporary chat">
          <History />
        </Button>
        <ThemeMenu />
      </div>
    </header>
  );
}
