import { THREAD_HISTORY_PAGE_SIZE, type ThreadSummary } from '@oci/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { type MouseEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LoadError } from '~/components/admin/admin-ui';
import { YourDataButtons } from '~/components/settings/your-data';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { useProjects, useProjectsAvailable } from '~/hooks/use-projects';
import { api, apiErrorMessage } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import { keepFocusWhenRemoved, placeBesideRows } from '~/lib/focus-return';
import { useReadOnlyLock } from '~/lib/read-only';
import { formatRelativeTime } from '~/lib/utils';
import { TrashList } from './trash-list';

/** How long typing pauses before the title search runs. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

const HISTORY_TABS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'trash', label: 'Trash' },
] as const;
const PANEL_ID = 'history-panel';

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
  // Archiving, deleting and restoring are refused while read-only (#353).
  const lock = useReadOnlyLock();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), HISTORY_SEARCH_DEBOUNCE_MS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
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
    mutationFn: (thread: ThreadSummary) => api.patch(`/threads/${thread.id}`, { archived: false }),
    // Said, as archiving is: the row only vanished (#250).
    onSuccess: (_, thread) => toast.success(`Restored “${thread.title}” to Active.`),
    onError: (error, thread) =>
      toast.error(apiErrorMessage(error, `“${thread.title}” could not be restored. Try again.`)),
    onSettled: () => invalidateConversationLists(queryClient),
  });

  /**
   * The bulk bar leaves as the selection clears, taking the focused button
   * with it, and the rows go when the list refetches: focus went to the body
   * (#189). It moves to the row that takes the first removed one's place,
   * which stays, else the one before, else the page's heading.
   */
  function runBulk(event: MouseEvent<HTMLButtonElement>, action: 'archive' | 'delete') {
    const removing = [...(listRef.current?.children ?? [])].filter(
      (row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
    );
    keepFocusWhenRemoved(event.currentTarget, placeBesideRows(event.currentTarget, removing));
    bulk.mutate({ ids: [...selected], action });
  }

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
                locked={lock.title}
                disabled={bulk.isPending}
                onClick={(event) => runBulk(event, 'archive')}
              >
                Archive
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              locked={lock.title}
              disabled={bulk.isPending}
              onClick={(event) => runBulk(event, 'delete')}
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
        // Announced, with Try again, as every other list's load error (#245).
        <LoadError
          title="Your conversations could not be loaded."
          query={history}
          className="mt-8"
        />
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
          <ul ref={listRef} aria-label="Conversations" className="flex flex-col">
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
                      // The full text on hover when a narrow screen cuts it short (#130).
                      title={thread.title}
                    >
                      {thread.title}
                    </Link>
                    {projectName && (
                      <p
                        className="truncate text-xs text-[var(--text-muted)]"
                        title={`Project: ${projectName}`}
                      >
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
                      // Only this row's: a disabled neighbour cannot take focus.
                      locked={lock.title}
                      disabled={unarchive.isPending && unarchive.variables?.id === thread.id}
                      aria-label={`Restore ${thread.title}`}
                      onClick={(event) => {
                        // The row leaves on refetch: focus goes to the next, not the body (#250).
                        const row = event.currentTarget.closest('li');
                        if (row) keepFocusWhenRemoved(row);
                        unarchive.mutate(thread);
                      }}
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
