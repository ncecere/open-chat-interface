import type { ThreadSummary } from '@oci/shared';
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
    mutationFn: () => api.post<{ thread: ThreadSummary }>('/threads', { temporary: false }),
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
