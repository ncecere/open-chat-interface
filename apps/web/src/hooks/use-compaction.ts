import type { CompactionState } from '@oci/shared';
import { type Query, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

const compactionQueryKey = (threadId: string) => ['thread', threadId, 'compaction'] as const;

/** How often a summary being made is checked on, and for how long at most. */
export const COMPACTION_POLL_MS = 3_000;
export const COMPACTION_POLL_WINDOW_MS = 2 * 60_000;

/** When each conversation's current summary was first seen pending. */
const pendingSince = new Map<string, number>();

/**
 * Summaries are made in the background. While one is pending, check briefly
 * so the divider appears when it is done; after the window, the next reply
 * (which reads the state again) picks it up instead.
 */
function pollWhilePending(threadId: string) {
  return (query: Query<CompactionState, Error, CompactionState, readonly unknown[]>) => {
    if (!query.state.data?.pending) {
      pendingSince.delete(threadId);
      return false as const;
    }
    const since = pendingSince.get(threadId) ?? Date.now();
    pendingSince.set(threadId, since);
    return Date.now() - since < COMPACTION_POLL_WINDOW_MS ? COMPACTION_POLL_MS : false;
  };
}

function useCompactionState<T>(
  threadId: string,
  select: (state: CompactionState) => T,
  enabled = true,
) {
  return useQuery({
    queryKey: compactionQueryKey(threadId),
    queryFn: ({ signal }) =>
      api.get<CompactionState>(`/threads/${encodeURIComponent(threadId)}/compaction`, { signal }),
    select,
    enabled,
    refetchInterval: pollWhilePending(threadId),
  });
}

const selectCompaction = (state: CompactionState) => state.compaction;
const selectPending = (state: CompactionState) => state.pending;
const selectSummarisable = (state: CompactionState) => state.summarisable ?? true;
// `?? null`: a response from an API older than v0.10 has no `failure`.
const selectFailure = (state: CompactionState) => state.failure ?? null;

/** The summary in use for a conversation, if its earlier messages were summarised. */
export function useCompaction(threadId: string, enabled = true) {
  return useCompactionState(threadId, selectCompaction, enabled);
}

/** Whether a summary of the conversation is being made in the background. */
export function useCompactionPending(threadId: string) {
  return useCompactionState(threadId, selectPending).data === true;
}

/**
 * Whether asking for a summary now has anything to summarise (#153); true
 * from a server that does not say, which then refuses on submit as before.
 */
export function useCompactionSummarisable(threadId: string) {
  return useCompactionState(threadId, selectSummarisable).data !== false;
}

/** The last failure of a summary the person asked for, until dismissed or retried. */
export function useCompactionFailure(threadId: string) {
  return useCompactionState(threadId, selectFailure).data ?? null;
}

/** Dismisses the report of a failed summary. */
export function useDismissCompactionFailure(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete<CompactionState>(`/threads/${encodeURIComponent(threadId)}/compaction/failure`),
    onSuccess: (data) => {
      queryClient.setQueryData(compactionQueryKey(threadId), data);
    },
  });
}

/**
 * "Summarise earlier messages now": queues a background summary and returns
 * at once; the conversation stays usable while it is made.
 */
export function useCompactThread(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instructions: string) =>
      api.post<CompactionState>(
        `/threads/${encodeURIComponent(threadId)}/compact`,
        instructions.trim() ? { instructions: instructions.trim() } : {},
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(compactionQueryKey(threadId), data);
    },
  });
}
