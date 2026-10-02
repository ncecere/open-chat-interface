import { THREAD_SEARCH_DEFAULT_LIMIT, type ThreadSearchResult } from '@oci/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '~/lib/api-client';

/** Delay before a typed query is sent, so each keystroke is not a request. */
export const SEARCH_DEBOUNCE_MS = 180;

export function useDebouncedValue<T>(value: T, delay = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}

/**
 * Full-text search over the signed-in person's conversations (titles and
 * message text). Disabled for an empty query. Lives under the `threads` key so
 * renaming, archiving or deleting a conversation refreshes open results.
 */
export function useThreadSearch(query: string, limit = THREAD_SEARCH_DEFAULT_LIMIT) {
  const q = query.trim();
  return useQuery({
    queryKey: ['threads', 'search', q, limit],
    queryFn: ({ signal }) =>
      api.get<{ results: ThreadSearchResult[] }>(
        `/threads/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        { signal },
      ),
    enabled: q.length > 0,
    select: (data) => data.results,
    placeholderData: keepPreviousData,
  });
}

/** Where a result opens: at its best-matching message when there is one. */
export function searchResultTarget(result: ThreadSearchResult) {
  const messageId = result.matches[0]?.messageId;
  return {
    to: '/chat/$threadId' as const,
    params: { threadId: result.thread.id },
    search: messageId ? { message: messageId } : {},
  };
}

export function searchResultsAnnouncement(count: number): string {
  if (count === 0) return 'No conversations matched.';
  return count === 1 ? '1 conversation found.' : `${count} conversations found.`;
}
