import { redirect } from '@tanstack/react-router';
import { takeRemovedConversation } from './unused-conversation';

/**
 * The conversation page's guard: the conversation this tab removed as it
 * closed or reloaded, never used (#266), opens as a new chat (in its project)
 * with the unsent text, rather than as "This conversation is unavailable".
 */
export function redirectRemovedConversation(threadId: string): void {
  const removed = takeRemovedConversation(threadId);
  if (removed)
    throw redirect({
      to: '/',
      search: removed.projectId ? { project: removed.projectId } : {},
      replace: true,
    });
}
