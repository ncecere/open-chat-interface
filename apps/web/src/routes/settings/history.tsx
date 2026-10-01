import type { ThreadSummary, TrashedThread } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { YourDataSection } from '~/components/settings/your-data';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread, useThreads, useUpdateThread } from '~/hooks/use-threads';
import { api } from '~/lib/api-client';
import { cn, formatRelativeTime } from '~/lib/utils';

type HistoryTab = 'active' | 'archived' | 'trash';

function purgeCountdown(purgeAt: string): string {
  const remaining = new Date(purgeAt).getTime() - Date.now();
  if (remaining <= 0) return 'deleting soon';

  const days = Math.ceil(remaining / 86_400_000);
  if (days > 1) return `deletes in ${days} days`;
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
  return `deletes in ${hours} hour${hours === 1 ? '' : 's'}`;
}

function TrashList() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['threads', 'trash'],
    queryFn: () => api.get<{ threads: TrashedThread[] }>('/threads/trash'),
    select: (result) => result.threads,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['threads'] }),
      queryClient.invalidateQueries({ queryKey: ['attachments'] }),
    ]);

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/threads/${id}/restore`),
    onSuccess: invalidate,
  });

  const purge = useMutation({
    mutationFn: (id: string) => api.delete(`/threads/${id}/permanent`),
    onSuccess: invalidate,
  });

  const emptyAll = useMutation({
    mutationFn: () => api.delete('/threads/trash'),
    onSuccess: invalidate,
  });

  const threads = data ?? [];

  if (isLoading) {
    return (
      <div className="py-16">
        <Spinner className="mx-auto size-6" />
      </div>
    );
  }

  if (threads.length === 0) {
    return <p className="mt-10 text-sm text-[var(--text-muted)]">Trash is empty.</p>;
  }

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-xs text-[var(--text-muted)]">
          Deleted conversations stay here until their deletion date, then are removed permanently.
          Deleting now cannot be undone, so download anything you want to keep first.
        </p>
        <Button
          variant="danger"
          size="sm"
          disabled={emptyAll.isPending}
          onClick={() => emptyAll.mutate()}
        >
          Empty trash
        </Button>
      </div>

      <div className="mt-4 flex flex-col">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className="flex items-center gap-3 border-[var(--border-subtle)] border-b py-3 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[var(--text-primary)] text-sm">{thread.title}</p>
              <p className="truncate text-[var(--text-muted)] text-xs">
                {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'} ·{' '}
                {thread.deletedReason === 'retention'
                  ? 'removed automatically'
                  : `deleted ${formatRelativeTime(thread.deletedAt)}`}{' '}
                · {purgeCountdown(thread.purgeAt)}
              </p>
            </div>

            <Button
              variant="secondary"
              size="sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate(thread.id)}
            >
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={purge.isPending}
              onClick={() => purge.mutate(thread.id)}
            >
              Delete now
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}

export function SettingsHistoryPage() {
  const [tab, setTab] = useState<HistoryTab>('active');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const showArchived = tab === 'archived';

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
        Threads are stored on this instance. Deleting one moves it to the trash, where it stays
        recoverable until its deletion date.
      </p>

      <div className="mt-6 flex items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-[var(--bg-control)]/45 p-1">
          {(
            [
              { label: 'Active', value: 'active' },
              { label: 'Archived', value: 'archived' },
              { label: 'Trash', value: 'trash' },
            ] as const
          ).map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => {
                setTab(entry.value);
                setSelected(new Set());
              }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                tab === entry.value
                  ? 'bg-[var(--bg-control-hover)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab !== 'trash' && selected.size > 0 && (
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

      {tab === 'trash' ? (
        <TrashList />
      ) : isLoading ? (
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

      <YourDataSection />
    </div>
  );
}
