import type { ThreadSummary } from '@oci/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { ApiError } from './api-client';
import type { ChatHistory } from './chat-history';

/**
 * Query keys and cache upkeep shared by everything that lists conversations.
 *
 * The sidebar reads two queries (v0.9.1): its general list
 * (`GET /threads?view=sidebar`, under `['threads']`) and its project tree
 * (`GET /projects/sidebar`, under `['projects']`). A change to a conversation
 * can move it between them, so every conversation change refreshes both
 * through invalidateConversationLists rather than each caller choosing.
 */

/** An object segment, so it can never equal a project id in `['projects', id]`. */
export const SIDEBAR_THREADS_KEY = ['threads', { view: 'sidebar' }] as const;
export const SIDEBAR_PROJECTS_KEY = ['projects', { view: 'sidebar' }] as const;

/** The open conversation's history; see routes/chat/thread.tsx. */
export function chatHistoryKey(threadId: string) {
  return ['thread', threadId, 'messages'] as const;
}

/**
 * Refreshes every conversation list and every project summary (whose counts
 * and sidebar rows depend on conversations). Project file lists are left
 * alone: no conversation change affects them.
 */
export function invalidateConversationLists(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['threads'] }),
    queryClient.invalidateQueries({
      queryKey: ['projects'],
      predicate: (query) => query.queryKey[2] !== 'files',
    }),
  ]);
}

/**
 * Copies a changed conversation into the open conversation's cached history.
 * That cache is never refetched while the conversation is open, and the
 * sidebar and the Move to project control read the conversation's project
 * and title from it.
 */
export function updateCachedConversation(queryClient: QueryClient, thread: ThreadSummary) {
  queryClient.setQueryData<ChatHistory>(chatHistoryKey(thread.id), (current) =>
    current ? { ...current, thread: { ...current.thread, ...thread } } : current,
  );
}

/**
 * The open conversation's summary as its history response gave it, without
 * fetching: undefined until the conversation page has loaded it. Read through
 * the cache rather than a second query observer, so the conversation page's
 * own caching options stay the only ones.
 */
export function useCachedConversation(threadId: string | undefined) {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, () =>
    threadId ? queryClient.getQueryData<ChatHistory>(chatHistoryKey(threadId))?.thread : undefined,
  );
}

/**
 * Whether the conversation at this address failed to load because it does not
 * exist or is not this person's (401, 403 or 404). The top bar then offers
 * none of its actions, which could only fail (#103).
 */
export function useConversationUnavailable(threadId: string | undefined): boolean {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, () => {
    if (!threadId) return false;
    const state = queryClient.getQueryState(chatHistoryKey(threadId));
    const error = state?.status === 'error' ? state.error : null;
    return error instanceof ApiError && [401, 403, 404].includes(error.status);
  });
}
