import type { ReasoningEffort, ThreadSummary } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

export function useThreads(search?: string) {
  return useQuery({
    queryKey: ['threads', search ?? ''],
    queryFn: () =>
      api.get<{ threads: ThreadSummary[] }>(
        `/threads${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
  });
}

export function useUpdateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<ThreadSummary>) =>
      api.patch(`/threads/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/threads/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
  });
}
