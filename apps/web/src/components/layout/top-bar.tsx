import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { Download, FolderInput, History, PanelLeft, Pencil, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CompactConversationControl } from '~/components/chat/compact-thread-dialog';
import { RenameThreadDialog } from '~/components/chat/rename-thread-dialog';
import { ShareThreadDialog } from '~/components/chat/share-thread-dialog';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { MoveToProjectDialog } from '~/components/projects/project-dialogs';
import { Button } from '~/components/ui/button';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useOpenConversation } from '~/hooks/use-open-conversation';
import { useConversationUnavailable } from '~/lib/conversation-cache';
import { ariaKeyShortcuts } from '~/lib/keyboard-shortcuts';
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
  // A conversation that does not exist (or is not yours) gets no actions:
  // each could only fail (#103).
  const unavailable = useConversationUnavailable(params.threadId);
  const threadId = unavailable ? undefined : params.threadId;

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
        <div
          data-floating-controls
          className="absolute left-2 top-6 flex items-center gap-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] p-1 shadow-sm"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSidebar}
            aria-label="Open sidebar"
            aria-keyshortcuts={ariaKeyShortcuts('toggle-sidebar')}
          >
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
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="New chat"
            aria-keyshortcuts={ariaKeyShortcuts('new-chat')}
          >
            <Link to="/" onClick={() => setTemporary(false)}>
              <Plus />
            </Link>
          </Button>
        </div>
      )}

      <div
        data-floating-controls
        className="absolute right-2 top-6 flex items-center gap-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] p-1 shadow-sm"
      >
        {threadId && <RenameConversationControl threadId={threadId} />}
        {threadId && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="Download this conversation"
            title="Download as Markdown"
          >
            {/* A plain link so the browser handles the download; the response
                carries its own filename. Dated in the person's own time zone,
                not the server's UTC (#211). */}
            <a
              href={`/api/threads/${threadId}/export?timeZone=${encodeURIComponent(
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              )}`}
              download
            >
              <Download />
            </a>
          </Button>
        )}
        {threadId && data?.features.shareLinks && <ShareThreadDialog threadId={threadId} />}
        {threadId && data?.features.projects && <MoveToProjectControl threadId={threadId} />}
        {threadId && <CompactConversationControl threadId={threadId} />}
        {/* Not offered to a role without temporary chats, as Attach is not
            (#99): a disabled button's reason was only a title, which a
            disabled button never shows or announces (#181). */}
        {available && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={temporary ? 'Leave temporary chat' : 'Start temporary chat'}
            aria-pressed={temporary}
            title="Temporary chat"
            onClick={toggleTemporary}
            className={cn(
              temporary &&
                'bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-bright)]',
            )}
          >
            <History />
          </Button>
        )}
        <ThemeMenu />
      </div>
    </header>
  );
}

/** Renames the conversation on screen; offered once its current name is known. */
function RenameConversationControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const title = useOpenConversation(threadId)?.thread.title;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rename conversation"
        title="Rename"
        aria-haspopup="dialog"
        disabled={title === undefined}
        onClick={() => setOpen(true)}
      >
        <Pencil />
      </Button>
      {title !== undefined && (
        <RenameThreadDialog threadId={threadId} title={title} open={open} onOpenChange={setOpen} />
      )}
    </>
  );
}

/** Opens the Move to project dialog for the conversation on screen. */
function MoveToProjectControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  // From the sidebar's cached lists, or the conversation's own history when
  // the sidebar does not list it (an older project conversation).
  const conversation = useOpenConversation(threadId)?.thread;
  const current = conversation?.projectId ?? null;
  // Temporary chats cannot join a project; offering it only led to a refusal (#91).
  if (conversation?.temporary) return null;

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
