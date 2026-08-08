import type { ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { Archive, ChevronDown, GitFork, Pin, PinOff } from 'lucide-react';
import { useState } from 'react';
import { Spinner } from '~/components/ui/spinner';
import { useThreads, useUpdateThread } from '~/hooks/use-threads';
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

function ThreadRow({ thread, active }: { thread: ThreadSummary; active: boolean }) {
  const update = useUpdateThread();

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg transition-colors',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
      )}
    >
      {thread.parentThreadId && (
        <Link
          to="/chat/$threadId"
          params={{ threadId: thread.parentThreadId }}
          aria-label="Go to parent thread"
          title="Go to parent thread"
          className="ml-2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <GitFork className="size-3.5" aria-hidden="true" />
        </Link>
      )}
      <Link
        to="/chat/$threadId"
        params={{ threadId: thread.id }}
        className="min-w-0 flex-1 truncate px-2.5 py-2 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
        title={thread.title}
      >
        {thread.title}
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
          aria-label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
          onClick={() => update.mutate({ id: thread.id, pinned: !thread.pinned })}
          className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {thread.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label="Archive thread"
          onClick={() => update.mutate({ id: thread.id, archived: true })}
          className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <Archive className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ThreadList({ search }: { search: string }) {
  const { data: threads, isLoading } = useThreads(search || undefined);
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
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        {search ? 'No threads matched.' : 'Your conversations will appear here.'}
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
            {isPinned ? (
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
            ) : (
              <p className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
                {group.label}
              </p>
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
