import type { ReasoningEffort, ThreadSummary } from '@oci/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { undoToast } from '~/components/ui/undo-toast';
import { api, apiErrorMessage } from '~/lib/api-client';
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

type ThreadPatch = { id: string } & Partial<ThreadSummary>;

/** "The conversation could not be pinned", for the change that failed. */
function failedChange(patch: ThreadPatch): string {
  if (patch.pinned !== undefined) return patch.pinned ? 'pinned' : 'unpinned';
  if (patch.archived !== undefined) return patch.archived ? 'archived' : 'restored';
  if (patch.title !== undefined) return 'renamed';
  return 'changed';
}

/**
 * Changes a conversation. With `reportErrors`, a refusal is shown as a toast
 * (the sidebar's Pin and Archive have nowhere else to say it); read-only
 * maintenance gives its reason and expected end rather than nothing at all
 * (#159). Set here rather than per call, so it fires even if the row has gone.
 */
export function useUpdateThread({ reportErrors = false }: { reportErrors?: boolean } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...patch }: ThreadPatch) =>
      api.patch<{ thread?: ThreadSummary }>(`/threads/${id}`, patch),
    onSuccess: (result) => {
      if (result?.thread) updateCachedConversation(queryClient, result.thread);
      return invalidateConversationLists(queryClient);
    },
    onError: reportErrors
      ? (error, patch) =>
          toast.error(`The conversation could not be ${failedChange(patch)}`, {
            id: `thread-change-${patch.id}`,
            description: apiErrorMessage(error, 'Try again.'),
          })
      : undefined,
  });
}

async function setArchived(queryClient: QueryClient, id: string, archived: boolean) {
  const result = await api.patch<{ thread?: ThreadSummary }>(`/threads/${id}`, { archived });
  if (result?.thread) updateCachedConversation(queryClient, result.thread);
  await invalidateConversationLists(queryClient);
}

/**
 * Archives a conversation and says so, with Undo (#101). The notice comes from
 * the mutation's own onSuccess, not a per-call `mutate(…, { onSuccess })`:
 * archiving refreshes the lists, which removes the sidebar row that asked, and
 * TanStack Query skips the per-call callbacks of a caller that has unmounted,
 * so a notice placed there never appeared (#125). Undo is a plain request for
 * the same reason: the row's own hook is gone by the time anyone selects it.
 */
export function useArchiveThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string; title: string }) => setArchived(queryClient, id, true),
    onSuccess: (_result, { id, title }) => {
      // Long enough to reach Undo, and kept while it has focus (#205).
      undoToast({
        id: `archived-${id}`,
        title: 'Conversation archived',
        description: title,
        onUndo: () => {
          setArchived(queryClient, id, false).catch(() =>
            toast.error('Could not restore the conversation. Try again from Settings → History.'),
          );
        },
      });
    },
    // A refused archive says why, e.g. the read-only reason (#159), as the
    // other row actions do through useUpdateThread({ reportErrors }).
    onError: (error, { id }) =>
      toast.error('The conversation could not be archived', {
        id: `thread-change-${id}`,
        description: apiErrorMessage(error, 'Try again.'),
      }),
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/threads/${id}`),
    onSuccess: () => invalidateConversationLists(queryClient),
  });
}
