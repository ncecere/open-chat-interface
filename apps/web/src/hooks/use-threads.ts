import type { ReasoningEffort, ThreadSummary } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import {
  invalidateConversationLists,
  SIDEBAR_THREADS_KEY,
  updateCachedConversation,
} from '~/lib/conversation-cache';

/**
 * The sidebar's general list: conversations in no project plus every pinned
 * one. Conversations in a project are listed under it (useSidebarProjects).
 */
export function useSidebarThreads() {
  return useQuery({
    queryKey: SIDEBAR_THREADS_KEY,
    queryFn: () => api.get<{ threads: ThreadSummary[] }>('/threads?view=sidebar'),
    select: (data) => data.threads,
  });
}

export function useCreateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options?: { temporary?: boolean; projectId?: string }) =>
      api.post<{ thread: ThreadSummary }>('/threads', {
        temporary: options?.temporary ?? false,
        ...(options?.projectId ? { projectId: options.projectId } : {}),
      }),
    onSuccess: () => invalidateConversationLists(queryClient),
  });
}

export interface BranchMessageResult {
  thread: ThreadSummary;
  message: {
    id: string;
    modelSlug: string | null;
    effort: ReasoningEffort | null;
  };
}

export function useForkMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, messageId }: { threadId: string; messageId: string }) =>
      api.post<{ thread: ThreadSummary }>(`/threads/${threadId}/forks`, { messageId }),
    onSuccess: () => invalidateConversationLists(queryClient),
  });
}

export function useBranchMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      messageId,
      text,
    }: {
      threadId: string;
      messageId: string;
      text: string;
    }) => api.post<BranchMessageResult>(`/threads/${threadId}/branches`, { messageId, text }),
    onSuccess: () => invalidateConversationLists(queryClient),
  });
}

export function useUpdateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<ThreadSummary>) =>
      api.patch<{ thread?: ThreadSummary }>(`/threads/${id}`, patch),
    onSuccess: (result) => {
      if (result?.thread) updateCachedConversation(queryClient, result.thread);
      return invalidateConversationLists(queryClient);
    },
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/threads/${id}`),
    onSuccess: () => invalidateConversationLists(queryClient),
  });
}
