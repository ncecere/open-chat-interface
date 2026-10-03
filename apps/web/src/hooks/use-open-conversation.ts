import type { ThreadSummary } from '@oci/shared';
import { useCachedConversation } from '~/lib/conversation-cache';
import { useProjectsAvailable, useSidebarProjects } from './use-projects';
import { useSidebarThreads } from './use-threads';

export interface OpenConversation {
  thread: Partial<ThreadSummary> & Pick<ThreadSummary, 'id'>;
  /**
   * Whether the thread is already a row in the sidebar: in the general list
   * (unfiled or pinned) or among its project's newest. False when only the
   * conversation page's own history has it, such as an older conversation in
   * a project.
   */
  listed: boolean;
}

/**
 * The conversation on screen as the sidebar knows it. The sidebar's own
 * queries are preferred, since they are refreshed after every change; the
 * conversation page's history fills in for one the sidebar does not list.
 * Both queries are the sidebar's, so this adds no requests.
 */
export function useOpenConversation(threadId: string | undefined): OpenConversation | undefined {
  const { data: threads } = useSidebarThreads();
  const { data: projects } = useSidebarProjects(useProjectsAvailable());
  const cached = useCachedConversation(threadId);
  if (!threadId) return undefined;

  const listed =
    threads?.find((thread) => thread.id === threadId) ??
    projects?.flatMap((project) => project.recentThreads).find((thread) => thread.id === threadId);
  if (listed) return { thread: listed, listed: true };
  return cached ? { thread: cached, listed: false } : undefined;
}
