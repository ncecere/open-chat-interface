import type {
  AccountSharingImpact,
  CreateProjectShareInput,
  MyGroup,
  ProjectAccessInfo,
  ProjectShare,
  ProjectSharePermission,
  ProjectSummary,
} from '@oci/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

/** The groups the person is in: the Share dialog's choices. */
export const MY_GROUPS_KEY = ['groups', 'mine'] as const;

/** What the caller may do and how many people and groups the project is shared with (counts only). */
export function useProjectAccess(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['projects', projectId, 'access'],
    queryFn: () => api.get<ProjectAccessInfo>(`${base(projectId)}/access`),
    enabled,
    // Who has access changes from outside this page: always read it again when it is asked for.
    staleTime: 0,
  });
}

/** The owner's share list. */
export function useProjectShares(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['projects', projectId, 'shares'],
    queryFn: () => api.get<{ shares: ProjectShare[] }>(`${base(projectId)}/shares`),
    select: (data) => data.shares,
    enabled,
    staleTime: 0,
  });
}

export function useMyGroups(enabled = true) {
  return useQuery({
    queryKey: MY_GROUPS_KEY,
    queryFn: () => api.get<{ groups: MyGroup[] }>('/groups/mine'),
    select: (data) => data.groups,
    enabled,
    staleTime: 0,
  });
}

export function useCreateShare(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectShareInput) =>
      api.post<{ share: ProjectShare }>(`${base(projectId)}/shares`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId] }),
  });
}

export function useUpdateShare(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      shareId,
      permission,
    }: {
      shareId: string;
      permission: ProjectSharePermission;
    }) =>
      api.patch<{ share: ProjectShare }>(
        `${base(projectId)}/shares/${encodeURIComponent(shareId)}`,
        {
          permission,
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId] }),
  });
}

export interface RemovedShare {
  ok: boolean;
  detachedThreads: number;
  movedFiles: number;
}

export function useRemoveShare(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      api.delete<RemovedShare>(`${base(projectId)}/shares/${encodeURIComponent(shareId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId] }),
  });
}

/** Gives the project to a person who holds a direct editor share; the caller becomes an editor. */
export function useTransferProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      api.post<{ project: ProjectSummary }>(`${base(projectId)}/transfer`, { email }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/**
 * Leaves a project shared directly with the person. It says so in an
 * announced notice from the mutation itself, since the project page that
 * asked has gone by the time the notice is wanted (#294). The lists are read
 * again by the caller once the page has moved on: refreshing first would show
 * "You no longer have access" for the project just left.
 */
export function useLeaveProject(projectId: string) {
  return useMutation({
    mutationFn: async (name: string) => ({
      ...(await api.post<RemovedShare>(`${base(projectId)}/leave`)),
      name,
    }),
    onSuccess: (result) => {
      toast.success(`You left “${result.name}”.`, {
        id: `project-left-${projectId}`,
        description:
          result.detachedThreads > 0
            ? 'Your conversations in it are kept in your conversation list.'
            : undefined,
      });
    },
  });
}

/** Reads every list again after leaving, then forgets the project: it is not the person's to load any more. */
export async function forgetProject(queryClient: QueryClient, projectId: string) {
  queryClient.removeQueries({ queryKey: ['projects', projectId] });
  await invalidateConversationLists(queryClient);
}

/**
 * What deleting an account does to other people through project sharing, for
 * the two delete dialogs. Read when the dialog opens, so the counts are the
 * ones the deletion would act on.
 */
export function useSharingImpact(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['sharing-impact', path],
    queryFn: () => api.get<AccountSharingImpact>(path),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
