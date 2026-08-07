import type { ThreadSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread, useThreads, useUpdateThread } from '~/hooks/use-threads';
import { api } from '~/lib/api-client';
import { cn, formatRelativeTime } from '~/lib/utils';

export function SettingsHistoryPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const active = useThreads();
  const archived = useQuery({
    queryKey: ['threads', 'archived'],
    queryFn: () => api.get<{ threads: ThreadSummary[] }>('/threads?archived=true'),
    select: (data) => data.threads,
    enabled: showArchived,
  });

  const update = useUpdateThread();
  const remove = useDeleteThread();

  const threads = (showArchived ? archived.data : active.data) ?? [];
  const isLoading = showArchived ? archived.isLoading : active.isLoading;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Message History</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Threads are stored on this instance. Deleting a thread also deletes its messages.
      </p>

      <div className="mt-6 flex items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-[var(--bg-control)]/45 p-1">
          {[
            { label: 'Active', value: false },
            { label: 'Archived', value: true },
          ].map((tab) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setShowArchived(tab.value)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                showArchived === tab.value
                  ? 'bg-[var(--bg-control-hover)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">{selected.size} selected</span>
            {!showArchived && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  for (const id of selected) update.mutate({ id, archived: true });
                  setSelected(new Set());
                }}
              >
                Archive
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                for (const id of selected) remove.mutate(id);
                setSelected(new Set());
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : threads.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {showArchived ? 'Nothing archived.' : 'No threads yet.'}
        </p>
      ) : (
        <div className="mt-6 flex flex-col">
          {threads.map((thread) => (
            <label
              key={thread.id}
              className="flex cursor-pointer items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0"
            >
              <input
                type="checkbox"
                checked={selected.has(thread.id)}
                onChange={() => toggle(thread.id)}
                className="size-4 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                {thread.title}
              </span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">
                {formatRelativeTime(thread.lastMessageAt ?? thread.createdAt)}
              </span>
              {showArchived && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.preventDefault();
                    update.mutate({ id: thread.id, archived: false });
                  }}
                >
                  Restore
                </Button>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
