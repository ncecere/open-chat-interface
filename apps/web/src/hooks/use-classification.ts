import type { ClassificationClass, ClassificationResponse, DataClassList } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';

/** What to ask about: one of the person's conversations, or one of their projects. */
export type ClassificationScope = { threadId: string } | { projectId: string };

/** Every classification query, for refreshing them together. */
export const CLASSIFICATION_KEY = ['classification'] as const;

function scopeKey(scope: ClassificationScope) {
  return 'threadId' in scope
    ? ([...CLASSIFICATION_KEY, 'thread', scope.threadId] as const)
    : ([...CLASSIFICATION_KEY, 'project', scope.projectId] as const);
}

function scopeQuery(scope: ClassificationScope): string {
  return 'threadId' in scope
    ? `threadId=${encodeURIComponent(scope.threadId)}`
    : `projectId=${encodeURIComponent(scope.projectId)}`;
}

/**
 * The classes a conversation or project carries, and which models may take
 * them, as the server computed them (`GET /api/classification`). Nothing is
 * asked while `scope` is null (a new chat outside any project has no classes).
 * While classification is off the answer is `{ mode: 'off', classes: [], models: [] }`.
 */
export function useClassification(scope: ClassificationScope | null) {
  return useQuery({
    queryKey: scope ? scopeKey(scope) : [...CLASSIFICATION_KEY, 'none'],
    queryFn: ({ signal }) =>
      api.get<ClassificationResponse>(`/classification?${scopeQuery(scope!)}`, { signal }),
    enabled: scope !== null,
    // A label can be added elsewhere (another tab, an administrator, a
    // connector's first use), so a stale answer is looked at again on focus.
    staleTime: 15_000,
  });
}

/** The classes a person may still add as a label (none while classification is off). */
export function useDataClasses(enabled = true) {
  return useQuery({
    queryKey: [...CLASSIFICATION_KEY, 'classes'],
    queryFn: () => api.get<DataClassList>('/data-classes'),
    select: (data) => data.classes,
    enabled,
  });
}

/** Every change of a label refreshes the answers and the lists that show labels. */
function useRefreshClassification() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: CLASSIFICATION_KEY }),
      invalidateConversationLists(queryClient),
    ]);
}

interface Labels {
  classes: ClassificationClass[];
}

/** Adds one of the person's own labels to a conversation. */
export function useAddThreadLabel(threadId: string) {
  const refresh = useRefreshClassification();
  return useMutation({
    mutationFn: (classId: string) =>
      api.post<Labels>(`/threads/${encodeURIComponent(threadId)}/data-classes`, { classId }),
    onSuccess: refresh,
  });
}

/** Removes a label the person added; the others are refused (409). */
export function useRemoveThreadLabel(threadId: string) {
  const refresh = useRefreshClassification();
  return useMutation({
    mutationFn: (classId: string) =>
      api.delete<Labels>(
        `/threads/${encodeURIComponent(threadId)}/data-classes/${encodeURIComponent(classId)}`,
      ),
    onSuccess: refresh,
  });
}

/** Replaces the whole list of a project's labels (an administrator's locked ones must stay). */
export function useSetProjectLabels(projectId: string) {
  const refresh = useRefreshClassification();
  return useMutation({
    mutationFn: (classIds: string[]) =>
      api.put<Labels>(`/projects/${encodeURIComponent(projectId)}/data-classes`, { classIds }),
    onSuccess: refresh,
  });
}
