import type { ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { Archive, ChevronDown, Folder, GitFork, Pencil, Pin, PinOff } from 'lucide-react';
import { useState } from 'react';
import { RenameThreadDialog } from '~/components/chat/rename-thread-dialog';
import { Spinner } from '~/components/ui/spinner';
import { useAutoRetry } from '~/hooks/use-auto-retry';
import {
  useProjectsAvailable,
  useSidebarProjects,
  useSidebarSharedProjects,
} from '~/hooks/use-projects';
import { useArchiveThread, useSidebarThreads, useUpdateThread } from '~/hooks/use-threads';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { type MessageKey, useT } from '~/lib/i18n';
import { readOnlyShortReason, useReadOnlyStatus } from '~/lib/read-only';
import { cn } from '~/lib/utils';

type GroupId = 'pinned' | 'today' | 'yesterday' | 'older';

const GROUP_LABELS: Record<GroupId, MessageKey> = {
  pinned: 'shell.threadList.pinned',
  today: 'shell.threadList.today',
  yesterday: 'shell.threadList.yesterday',
  older: 'shell.threadList.older',
};

/** Groups by local calendar date, matching the reference's Today/Yesterday buckets. */
function groupThreads(threads: ThreadSummary[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups: { id: GroupId; threads: ThreadSummary[] }[] = [
    { id: 'pinned', threads: [] },
    { id: 'today', threads: [] },
    { id: 'yesterday', threads: [] },
    { id: 'older', threads: [] },
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

/**
 * 24 by 24 px, the WCAG 2.2 target floor (2.5.8): the 14 px icon with `p-1` was 22 by 22, with
 * 2 px between the three, so neither the size nor the spacing exception held.
 */
const ROW_ACTION =
  'flex size-6 items-center justify-center rounded text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The room the three actions take at the end of a row: 4 px from the edge, three 24 px buttons and
 * two 2 px gaps, 80 px. The link gives it up while the actions show (`me-20` is 5rem), so they sit
 * beside the conversation title, not over its last letters or over the link's own box, which is
 * what the audit counted as the focused link being partly covered (2.4.11). Not animated: the
 * link must be clear of them the moment it has focus, not 200 ms later.
 */
const ACTIONS_ROOM = 'group-hover:me-20 group-focus-within:me-20';

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
  const t = useT();
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
          aria-label={t('shell.threadRow.parent', { title: thread.title })}
          title={t('shell.threadRow.parentTitle')}
          // 24 × 24, the WCAG 2.2 target floor; it was the 14 px icon plus
          // padding, 22 × 22, right against the row's link (#193).
          className="ms-1.5 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <GitFork className="size-3.5" aria-hidden="true" />
        </Link>
      )}
      <Link
        to="/chat/$threadId"
        params={{ threadId: thread.id }}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]',
          ACTIONS_ROOM,
        )}
        title={
          projectName
            ? t('shell.threadRow.titleInProject', { title: thread.title, project: projectName })
            : thread.title
        }
      >
        <span
          dir="auto"
          className="min-w-0 flex-1 line-clamp-2 text-ellipsis [overflow-wrap:anywhere]"
        >
          {thread.title}
        </span>
        {projectName && (
          <span
            className={cn(
              'flex max-w-[40%] shrink-0 items-center gap-1 text-[0.6875rem]',
              // Muted text is too faint on the highlighted row's background.
              active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]',
            )}
          >
            <Folder className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t('shell.threadRow.inProject')} </span>
            <span className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere]">
              {projectName}
            </span>
          </span>
        )}
      </Link>

      <div
        className={cn(
          'pointer-events-none absolute end-1 flex translate-x-3 items-center gap-0.5 opacity-0 rtl:-translate-x-3',
          'transition-[transform,opacity] duration-200 ease-out',
          'group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100',
          'group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
      >
        <button
          type="button"
          aria-label={t(thread.pinned ? 'shell.threadRow.unpin' : 'shell.threadRow.pin', {
            title: thread.title,
          })}
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={() => update.mutate({ id: thread.id, pinned: !thread.pinned })}
          className={ROW_ACTION}
        >
          {thread.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label={t('shell.threadRow.rename', { title: thread.title })}
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
          aria-label={t('shell.threadRow.archive', { title: thread.title })}
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
  const t = useT();
  const { data: threads, isLoading, isError, refetch } = useSidebarThreads();
  // A refresh that failed while the server was unreachable (the end of a new
  // chat's first reply during an outage) is tried again by itself, as the
  // projects are (#233); the list kept "New Chat" until a reload (#249).
  useAutoRetry(isError, () => void refetch());
  const projectsAvailable = useProjectsAvailable();
  const { data: projects } = useSidebarProjects(projectsAvailable);
  const { data: shared } = useSidebarSharedProjects(projectsAvailable);
  const projectNames = new Map(
    [...(projects ?? []), ...(shared ?? [])].map((project) => [project.id, project.name]),
  );
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
    if ([...(projects ?? []), ...(shared ?? [])].some((project) => project.threadCount > 0))
      return null;
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        {t('shell.threadList.empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groupThreads(threads).map((group) => {
        const isPinned = group.id === 'pinned';
        const visible = !isPinned || pinnedOpen;

        return (
          <div key={group.id}>
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
                  className="flex min-h-6 w-full items-center gap-1 rounded px-2.5 pb-1 text-start text-[0.6875rem] font-semibold text-[var(--accent-bright)] hover:text-[var(--text-primary)]"
                >
                  <ChevronDown
                    className={cn('size-3 transition-transform', !pinnedOpen && '-rotate-90')}
                    aria-hidden="true"
                  />
                  {t(GROUP_LABELS.pinned)}
                </button>
              </h2>
            ) : (
              <h2 className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
                {t(GROUP_LABELS[group.id])}
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
