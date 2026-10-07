import type { ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { Archive, ChevronDown, Folder, GitFork, Pencil, Pin, PinOff } from 'lucide-react';
import { useState } from 'react';
import { RenameThreadDialog } from '~/components/chat/rename-thread-dialog';
import { Spinner } from '~/components/ui/spinner';
import { useProjectsAvailable, useSidebarProjects } from '~/hooks/use-projects';
import { useArchiveThread, useSidebarThreads, useUpdateThread } from '~/hooks/use-threads';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { readOnlyShortReason, useReadOnlyStatus } from '~/lib/read-only';
import { cn } from '~/lib/utils';

/** Groups by local calendar date, matching the reference's Today/Yesterday buckets. */
function groupThreads(threads: ThreadSummary[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups: { label: string; threads: ThreadSummary[] }[] = [
    { label: 'Pinned', threads: [] },
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Older', threads: [] },
  ];

  for (const thread of threads) {
    const activity = new Date(thread.lastMessageAt ?? thread.updatedAt);
    if (thread.pinned) groups[0]?.threads.push(thread);
    else if (activity >= today) groups[1]?.threads.push(thread);
    else if (activity >= yesterday) groups[2]?.threads.push(thread);
    else groups[3]?.threads.push(thread);
  }

  return groups.filter((group) => group.threads.length > 0);
}

const ROW_ACTION =
  'rounded p-1 text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50';

/** One conversation in the sidebar, with its pin, rename and archive actions. */
export function ThreadRow({
  thread,
  active,
  projectName,
}: {
  thread: ThreadSummary;
  active: boolean;
  /** Shown lightly after the title of a pinned project conversation. */
  projectName?: string;
}) {
  const update = useUpdateThread({ reportErrors: true });
  const archive = useArchiveThread();
  const [renaming, setRenaming] = useState(false);
  // Off while read-only, with the reason, as the message actions are (#159).
  const readOnly = useReadOnlyStatus();
  const lockedTitle = readOnly.active ? readOnlyShortReason(readOnly) : undefined;

  return (
    <div
      // A row focus can move to when a neighbour is archived (#128).
      data-focus-row=""
      className={cn(
        'group relative flex items-center rounded-lg transition-colors',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
      )}
    >
      {thread.parentThreadId && (
        <Link
          to="/chat/$threadId"
          params={{ threadId: thread.parentThreadId }}
          // Each row's controls are named for the row, as memory's are, so a
          // screen reader's list of buttons is not N copies of one name (#111).
          aria-label={`Go to parent thread of: ${thread.title}`}
          title="Go to parent thread"
          // 24 × 24, the WCAG 2.2 target floor; it was the 14 px icon plus
          // padding, 22 × 22, right against the row's link (#193).
          className="ml-1.5 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <GitFork className="size-3.5" aria-hidden="true" />
        </Link>
      )}
      <Link
        to="/chat/$threadId"
        params={{ threadId: thread.id }}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
        title={projectName ? `${thread.title} (${projectName})` : thread.title}
      >
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {projectName && (
          <span
            className={cn(
              'flex max-w-[40%] shrink-0 items-center gap-1 text-[0.6875rem]',
              // Muted text is too faint on the highlighted row's background.
              active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]',
            )}
          >
            <Folder className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">, in project </span>
            <span className="truncate">{projectName}</span>
          </span>
        )}
      </Link>

      <div
        className={cn(
          'pointer-events-none absolute right-1 flex translate-x-3 items-center gap-0.5 rounded-lg bg-inherit pl-2 opacity-0',
          'transition-[transform,opacity] duration-200 ease-out',
          'group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100',
          'group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
      >
        <button
          type="button"
          aria-label={`${thread.pinned ? 'Unpin' : 'Pin'} thread: ${thread.title}`}
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={() => update.mutate({ id: thread.id, pinned: !thread.pinned })}
          className={ROW_ACTION}
        >
          {thread.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label={`Rename thread: ${thread.title}`}
          aria-haspopup="dialog"
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={() => setRenaming(true)}
          className={ROW_ACTION}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Archive thread: ${thread.title}`}
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={(event) => {
            // The row leaves the list: focus moves to the next row, not the body (#128).
            const row = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
            if (row) keepFocusWhenRemoved(row);
            // Said, with a way back, rather than the row just vanishing (#101, #125).
            archive.mutate({ id: thread.id, title: thread.title });
          }}
          className={ROW_ACTION}
        >
          <Archive className="size-3.5" />
        </button>
      </div>
      <RenameThreadDialog
        threadId={thread.id}
        title={thread.title}
        open={renaming}
        onOpenChange={setRenaming}
      />
    </div>
  );
}

/**
 * The sidebar's general list: Pinned (every pinned conversation, project ones
 * labelled with their project), then conversations in no project by day.
 * Unpinned project conversations are listed under their project instead
 * (SidebarProjects).
 */
export function ThreadList() {
  const { data: threads, isLoading } = useSidebarThreads();
  const projectsAvailable = useProjectsAvailable();
  const { data: projects } = useSidebarProjects(projectsAvailable);
  const projectNames = new Map(projects?.map((project) => [project.id, project.name]));
  const params = useParams({ strict: false }) as { threadId?: string };
  const [pinnedOpen, setPinnedOpen] = useState(true);

  if (isLoading) {
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  }

  if (!threads || threads.length === 0) {
    // Someone whose every conversation is in a project has nothing to add here.
    if (projects?.some((project) => project.threadCount > 0)) return null;
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your conversations will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groupThreads(threads).map((group) => {
        const isPinned = group.label === 'Pinned';
        const visible = !isPinned || pinnedOpen;

        return (
          <div key={group.label}>
            {/* Every group is a heading, as Projects is, so heading navigation
                reaches each day; they were paragraphs, and Pinned a bare
                button (#198). Pinned's disclosure sits inside its heading. */}
            {isPinned ? (
              <h2>
                <button
                  type="button"
                  aria-expanded={pinnedOpen}
                  aria-controls="pinned-thread-list"
                  onClick={() => setPinnedOpen((open) => !open)}
                  // min-h keeps the target at the 24px WCAG 2.2 floor; the label
                  // itself is deliberately small, so padding carries the height.
                  className="flex min-h-6 w-full items-center gap-1 rounded px-2.5 pb-1 text-left text-[0.6875rem] font-semibold text-[var(--accent-bright)] hover:text-[var(--text-primary)]"
                >
                  <ChevronDown
                    className={cn('size-3 transition-transform', !pinnedOpen && '-rotate-90')}
                    aria-hidden="true"
                  />
                  Pinned
                </button>
              </h2>
            ) : (
              <h2 className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
                {group.label}
              </h2>
            )}
            {visible && (
              <div
                id={isPinned ? 'pinned-thread-list' : undefined}
                className="flex flex-col gap-0.5"
              >
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={params.threadId === thread.id}
                    projectName={
                      isPinned && thread.projectId ? projectNames.get(thread.projectId) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
