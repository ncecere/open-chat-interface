import type {
  CreateProjectInput,
  ProjectFile,
  ProjectSummary,
  SidebarProject,
  ThreadSummary,
  UpdateProjectInput,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from '~/lib/api-client';
import {
  invalidateConversationLists,
  SIDEBAR_PROJECTS_KEY,
  updateCachedConversation,
} from '~/lib/conversation-cache';
import { useCurrentUser } from './use-current-user';

/** Whether this person's role may use projects; false until /me has loaded. */
export function useProjectsAvailable(): boolean {
  const { data } = useCurrentUser();
  return data?.features.projects ?? false;
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectSummary[] }>('/projects'),
    select: (data) => data.projects,
    enabled,
  });
}

/**
 * The sidebar's project tree: each project with its conversation count and
 * newest unpinned conversations. Under `['projects']`, so every project and
 * conversation change refreshes it.
 */
export function useSidebarProjects(enabled = true) {
  return useQuery({
    queryKey: SIDEBAR_PROJECTS_KEY,
    queryFn: () => api.get<{ projects: SidebarProject[] }>('/projects/sidebar'),
    select: (data) => data.projects,
    enabled,
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId],
    queryFn: () =>
      api.get<{ project: ProjectSummary }>(`/projects/${encodeURIComponent(projectId ?? '')}`),
    select: (data) => data.project,
    enabled: Boolean(projectId),
  });
}

export function useProjectFiles(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['projects', projectId, 'files'],
    queryFn: () =>
      api.get<{ files: ProjectFile[] }>(`/projects/${encodeURIComponent(projectId)}/files`),
    select: (data) => data.files,
    enabled,
  });
}

export function useProjectThreads(projectId: string) {
  return useQuery({
    queryKey: ['threads', 'project', projectId],
    queryFn: () =>
      api.get<{ threads: ThreadSummary[] }>(`/threads?projectId=${encodeURIComponent(projectId)}`),
    select: (data) => data.threads,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      api.post<{ project: ProjectSummary }>('/projects', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateProjectInput) =>
      api.patch<{ project: ProjectSummary }>(`/projects/${encodeURIComponent(projectId)}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** What a deleted project's notice adds: where its conversations went. */
export function deletedProjectText(detachedThreads: number): string | undefined {
  if (detachedThreads === 0) return undefined;
  return detachedThreads === 1
    ? 'Its conversation is kept in your conversation list.'
    : `Its ${detachedThreads} conversations are kept in your conversation list.`;
}

/**
 * Deletes a project and says so (#294): the page then goes home, where
 * nothing else said what happened. The notice comes from the mutation's own
 * onSuccess, since the project page that asked has gone by then (#125).
 */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      api.delete<{ ok: boolean; detachedThreads: number; removedFiles: number }>(
        `/projects/${encodeURIComponent(id)}`,
      ),
    onSuccess: (result, { id, name }) => {
      toast.success(`Project “${name}” deleted.`, {
        id: `project-deleted-${id}`,
        description: deletedProjectText(result?.detachedThreads ?? 0),
      });
      // Its conversations move to the general list.
      return invalidateConversationLists(queryClient);
    },
  });
}

/** Uploads one file at a time so each failure is reported against its file. */
export function useUploadProjectFiles(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]) => {
      const failures: string[] = [];
      for (const file of files) {
        const body = new FormData();
        body.append('files', file);
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
          method: 'POST',
          body,
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          failures.push(payload?.error?.message ?? `${file.name} could not be uploaded`);
        }
      }
      if (failures.length > 0) throw new ApiError(422, 'UPLOAD_FAILED', failures.join(' '));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProjectFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api.delete(`/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/**
 * Moves a conversation into a project, or out of one with `null`, and says so
 * (#294): the conversation on screen does not change, and the only sign was
 * its row moving in the sidebar, which nobody hears. `projectName` is the
 * project it goes to, `fromProjectName` the one it leaves.
 */
export function useMoveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      threadId,
      projectId,
    }: {
      threadId: string;
      projectId: string | null;
      projectName?: string | null;
      fromProjectName?: string | null;
    }) =>
      api.patch<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(threadId)}`, {
        projectId,
      }),
    onSuccess: (result, { threadId, projectId, projectName, fromProjectName }) => {
      toast.success(
        projectId
          ? `Conversation moved to ${projectName ? `“${projectName}”` : 'the project'}.`
          : `Conversation moved out of ${fromProjectName ? `“${fromProjectName}”` : 'its project'}.`,
        { id: `thread-moved-${threadId}` },
      );
      if (result?.thread) updateCachedConversation(queryClient, result.thread);
      return invalidateConversationLists(queryClient);
    },
  });
}
