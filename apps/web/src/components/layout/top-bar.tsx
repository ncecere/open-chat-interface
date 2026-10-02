import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { Download, FolderInput, History, PanelLeft, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ShareThreadDialog } from '~/components/chat/share-thread-dialog';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { MoveToProjectDialog } from '~/components/projects/project-dialogs';
import { Button } from '~/components/ui/button';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useThreads } from '~/hooks/use-threads';
import { cn } from '~/lib/utils';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

interface TopBarProps {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onOpenCommandPalette: () => void;
}

/**
 * Thin band above the main panel, matching the reference layout. The band is
 * only a few pixels tall, so the controls it owns are rendered as pills that
 * hang below it over the panel.
 */
export function TopBar({ sidebarOpen, onOpenSidebar, onOpenCommandPalette }: TopBarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams({ strict: false }) as { threadId?: string };
  const { data } = useCurrentUser();
  const { temporary, setTemporary } = useTemporaryChat();
  const available = data?.features.temporaryChat ?? false;

  useEffect(() => {
    if (data && !available && temporary) setTemporary(false);
  }, [available, data, setTemporary, temporary]);

  function toggleTemporary() {
    if (!available) return;
    setTemporary(!temporary);
    if (location.pathname !== '/') void navigate({ to: '/' });
  }

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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenCommandPalette}
            aria-label="Search commands and threads"
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Search />
          </Button>
          <Button variant="ghost" size="icon-sm" asChild aria-label="New chat">
            <Link to="/" onClick={() => setTemporary(false)}>
              <Plus />
            </Link>
          </Button>
        </div>
      )}

      <div className="absolute right-2 top-6 flex items-center gap-0.5 rounded-xl bg-[var(--bg-pill)] p-1">
        {params.threadId && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="Download this conversation"
            title="Download as Markdown"
          >
            {/* A plain link so the browser handles the download; the response
                carries its own filename. */}
            <a href={`/api/threads/${params.threadId}/export`} download>
              <Download />
            </a>
          </Button>
        )}
        {params.threadId && data?.features.shareLinks && (
          <ShareThreadDialog threadId={params.threadId} />
        )}
        {params.threadId && data?.features.projects && (
          <MoveToProjectControl threadId={params.threadId} />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!available}
          aria-label={temporary ? 'Leave temporary chat' : 'Start temporary chat'}
          aria-pressed={temporary}
          title={available ? 'Temporary chat' : 'Temporary chat is unavailable'}
          onClick={toggleTemporary}
          className={cn(
            temporary &&
              'bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-bright)]',
          )}
        >
          <History />
        </Button>
        <ThemeMenu />
      </div>
    </header>
  );
}

/** Opens the Move to project dialog for the conversation on screen. */
function MoveToProjectControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  // The sidebar's list is already cached; archived conversations are not in
  // it and simply start from "No project" until moved.
  const { data: threads } = useThreads();
  const current = threads?.find((thread) => thread.id === threadId)?.projectId ?? null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Move to project"
        title="Move to project"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <FolderInput />
      </Button>
      <MoveToProjectDialog
        threadId={threadId}
        currentProjectId={current}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
