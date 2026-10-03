import { THREAD_HISTORY_PAGE_SIZE, type ThreadSummary, type TrashedThread } from '@oci/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { YourDataButtons } from '~/components/settings/your-data';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { useProjects, useProjectsAvailable } from '~/hooks/use-projects';
import { api, apiErrorMessage } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import { formatRelativeTime } from '~/lib/utils';

/** How long typing pauses before the title search runs. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

const HISTORY_TABS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'trash', label: 'Trash' },
] as const;
const PANEL_ID = 'history-panel';

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
      invalidateConversationLists(queryClient),
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

interface HistoryPage {
  threads: ThreadSummary[];
  nextCursor: string | null;
}

function historyPath(archived: boolean, search: string, before: string | null): string {
  const params = new URLSearchParams({ view: 'history', limit: String(THREAD_HISTORY_PAGE_SIZE) });
  if (archived) params.set('archived', 'true');
  if (search) params.set('search', search);
  if (before) params.set('before', before);
  return `/threads?${params}`;
}

/** The value after it has stopped changing for `delay` milliseconds. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function plural(count: number): string {
  return `${count} conversation${count === 1 ? '' : 's'}`;
}

/** A header checkbox that is checked, unchecked or mixed. */
function SelectAll({
  total,
  selected,
  onChange,
}: {
  total: number;
  selected: number;
  onChange: () => void;
}) {
  const all = total > 0 && selected === total;
  const some = selected > 0 && !all;
  return (
    <label className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
      <input
        ref={(node) => {
          if (node) node.indeterminate = some;
        }}
        type="checkbox"
        checked={all}
        aria-checked={some ? 'mixed' : all}
        disabled={total === 0}
        onChange={onChange}
        className="size-4 accent-[var(--accent)]"
      />
      Select all
    </label>
  );
}

function ConversationList({ archived }: { archived: boolean }) {
  const queryClient = useQueryClient();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), HISTORY_SEARCH_DEBOUNCE_MS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const projectsAvailable = useProjectsAvailable();
  const projects = useProjects(projectsAvailable);
  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );

  const history = useInfiniteQuery({
    queryKey: ['threads', 'history', { archived, search }],
    queryFn: ({ pageParam }) => api.get<HistoryPage>(historyPath(archived, search, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const threads = useMemo(
    () => history.data?.pages.flatMap((page) => page.threads) ?? [],
    [history.data],
  );

  // A new search starts a new selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on search change only
  useEffect(() => setSelected(new Set()), [search]);

  const selectedOnPage = threads.filter((thread) => selected.has(thread.id));

  /** One request per conversation (there is no bulk endpoint), one toast. */
  const bulk = useMutation({
    mutationFn: async ({ ids, action }: { ids: string[]; action: 'archive' | 'delete' }) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          action === 'archive'
            ? api.patch(`/threads/${id}`, { archived: true })
            : api.delete(`/threads/${id}`),
        ),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      return { done: ids.length - failed.length, failed: failed.length, action };
    },
    onSuccess: ({ done, failed, action }) => {
      if (done > 0) {
        toast.success(
          action === 'archive'
            ? `Archived ${plural(done)}.`
            : `Moved ${plural(done)} to the trash.`,
        );
      }
      if (failed > 0) toast.error(`${plural(failed)} could not be changed. Try again.`);
      setSelected(new Set());
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'That could not be done. Try again.')),
    onSettled: () =>
      Promise.all([
        invalidateConversationLists(queryClient),
        queryClient.invalidateQueries({ queryKey: ['attachments'] }),
      ]),
  });

  const unarchive = useMutation({
    mutationFn: (id: string) => api.patch(`/threads/${id}`, { archived: false }),
    onSettled: () => invalidateConversationLists(queryClient),
  });

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const everySelected = threads.length > 0 && selectedOnPage.length === threads.length;
    setSelected(everySelected ? new Set() : new Set(threads.map((thread) => thread.id)));
  }

  return (
    <>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <label htmlFor={searchId} className="sr-only">
            Search conversation titles
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Search titles"
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 sm:ml-auto">
            <span className="text-xs text-[var(--text-muted)]">{selected.size} selected</span>
            {!archived && (
              <Button
                variant="secondary"
                size="sm"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate({ ids: [...selected], action: 'archive' })}
              >
                Archive
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ ids: [...selected], action: 'delete' })}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {history.isLoading ? (
        <div className="py-16" role="status" aria-label="Loading conversations">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : history.isError ? (
        <p role="alert" className="mt-8 text-sm text-[var(--danger)]">
          Your conversations could not be loaded. Reload the page to try again.
        </p>
      ) : threads.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {search
            ? 'No conversation titles match your search.'
            : archived
              ? 'Nothing archived.'
              : 'No conversations yet.'}
        </p>
      ) : (
        <>
          <div className="mt-4 border-b border-[var(--border-subtle)] pb-2">
            <SelectAll
              total={threads.length}
              selected={selectedOnPage.length}
              onChange={toggleAll}
            />
          </div>
          <ul aria-label="Conversations" className="flex flex-col">
            {threads.map((thread) => {
              const projectName = thread.projectId ? projectNames.get(thread.projectId) : undefined;
              return (
                <li
                  key={thread.id}
                  className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(thread.id)}
                    onChange={() => toggle(thread.id)}
                    aria-label={`Select ${thread.title}`}
                    className="size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/chat/$threadId"
                      params={{ threadId: thread.id }}
                      className="block truncate text-sm text-[var(--text-primary)] hover:underline"
                    >
                      {thread.title}
                    </Link>
                    {projectName && (
                      <p className="truncate text-xs text-[var(--text-muted)]">
                        Project: {projectName}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {formatRelativeTime(thread.lastMessageAt ?? thread.createdAt)}
                  </span>
                  {archived && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={unarchive.isPending}
                      aria-label={`Restore ${thread.title}`}
                      onClick={() => unarchive.mutate(thread.id)}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {history.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage && <Spinner />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function SettingsHistoryPage() {
  const [tab, setTab] = useState<(typeof HISTORY_TABS)[number]['id']>('active');

  return (
    <div>
      <h1 className="text-2xl font-bold">History</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Your conversations on this instance. Deleting one moves it to the trash, where it stays
        recoverable until its deletion date.
      </p>

      <YourDataButtons />

      <div className="mt-6">
        <PillTabs
          tabs={HISTORY_TABS}
          active={tab}
          onChange={setTab}
          label="Conversations"
          controls={PANEL_ID}
        />
      </div>

      <div
        id={PANEL_ID}
        role="tabpanel"
        aria-label={HISTORY_TABS.find((entry) => entry.id === tab)?.label}
      >
        {tab === 'trash' ? (
          <TrashList />
        ) : (
          <ConversationList key={tab} archived={tab === 'archived'} />
        )}
      </div>
    </div>
  );
}
