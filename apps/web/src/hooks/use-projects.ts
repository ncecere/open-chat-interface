import type {
  CreateProjectInput,
  ProjectFile,
  ProjectSummary,
  ThreadSummary,
  UpdateProjectInput,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '~/lib/api-client';
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

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId],
    queryFn: () =>
      api.get<{ project: ProjectSummary }>(`/projects/${encodeURIComponent(projectId ?? '')}`),
    select: (data) => data.project,
    enabled: Boolean(projectId),
  });
}

export function useProjectFiles(projectId: string) {
  return useQuery({
    queryKey: ['projects', projectId, 'files'],
    queryFn: () =>
      api.get<{ files: ProjectFile[] }>(`/projects/${encodeURIComponent(projectId)}/files`),
    select: (data) => data.files,
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

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.delete<{ ok: boolean; detachedThreads: number; removedFiles: number }>(
        `/projects/${encodeURIComponent(projectId)}`,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['threads'] }),
      ]);
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

/** Moves a conversation into a project, or out of one with `null`. */
export function useMoveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, projectId }: { threadId: string; projectId: string | null }) =>
      api.patch<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(threadId)}`, {
        projectId,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['threads'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
      ]);
    },
  });
}
