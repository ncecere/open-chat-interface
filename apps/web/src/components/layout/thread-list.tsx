import type { ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { Archive, Pin, PinOff, Trash2 } from 'lucide-react';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread, useThreads, useUpdateThread } from '~/hooks/use-threads';
import { cn } from '~/lib/utils';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Groups threads the way the reference sidebar does. */
function groupThreads(threads: ThreadSummary[]) {
  const now = Date.now();
  const groups: { label: string; threads: ThreadSummary[] }[] = [
    { label: 'Pinned', threads: [] },
    { label: 'Today', threads: [] },
    { label: 'Last 7 days', threads: [] },
    { label: 'Older', threads: [] },
  ];

  for (const thread of threads) {
    const age = now - new Date(thread.lastMessageAt ?? thread.updatedAt).getTime();

    if (thread.pinned) groups[0]?.threads.push(thread);
    else if (age < DAY_MS) groups[1]?.threads.push(thread);
    else if (age < 7 * DAY_MS) groups[2]?.threads.push(thread);
    else groups[3]?.threads.push(thread);
  }

  return groups.filter((group) => group.threads.length > 0);
}

function ThreadRow({ thread, active }: { thread: ThreadSummary; active: boolean }) {
  const update = useUpdateThread();
  const remove = useDeleteThread();

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg transition-colors',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
      )}
    >
      <Link
        to="/chat/$threadId"
        params={{ threadId: thread.id }}
        className="min-w-0 flex-1 truncate px-2.5 py-2 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
        title={thread.title}
      >
        {thread.title}
      </Link>

      <div className="absolute right-1 hidden items-center gap-0.5 rounded-lg bg-inherit pl-2 group-hover:flex">
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
        <button
          type="button"
          aria-label="Delete thread"
          onClick={() => remove.mutate(thread.id)}
          className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--danger-foreground)]"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ThreadList({ search }: { search: string }) {
  const { data: threads, isLoading } = useThreads(search || undefined);
  const params = useParams({ strict: false }) as { threadId?: string };

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
      {groupThreads(threads).map((group) => (
        <div key={group.label}>
          <p className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
            {group.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} active={params.threadId === thread.id} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
