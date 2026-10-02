import type { ConversationCompaction } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

export const compactionQueryKey = (threadId: string) => ['thread', threadId, 'compaction'] as const;

/** The summary in use for a conversation, if its earlier messages were summarised. */
export function useCompaction(threadId: string, enabled = true) {
  return useQuery({
    queryKey: compactionQueryKey(threadId),
    queryFn: ({ signal }) =>
      api.get<{ compaction: ConversationCompaction | null }>(
        `/threads/${encodeURIComponent(threadId)}/compaction`,
        { signal },
      ),
    select: (data) => data.compaction,
    enabled,
  });
}

/** "Compact conversation": summarise the earlier messages now. */
export function useCompactThread(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instructions: string) =>
      api.post<{ compaction: ConversationCompaction }>(
        `/threads/${encodeURIComponent(threadId)}/compact`,
        instructions.trim() ? { instructions: instructions.trim() } : {},
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(compactionQueryKey(threadId), { compaction: data.compaction });
    },
  });
}
