import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';

/**
 * Removes a conversation left unused when the person leaves it (#234).
 *
 * The new-chat page creates the conversation before handing it its first
 * message. When that message is refused before it is saved (a server
 * restarting, a rate limit), the text goes back to the composer and the
 * person can send it again here; but if they leave instead, the empty "New
 * Chat" stayed in their history until the daily cleanup. While `unused` is
 * true, leaving the page for another in the app asks the server to remove it;
 * the server removes it only if it is still untitled and without a message,
 * so a send accepted meanwhile is safe. Not on closing the tab: a reload
 * would then open a conversation that is gone; the daily cleanup has those.
 */
export function useRemoveUnusedConversation(threadId: string, unused: boolean) {
  const queryClient = useQueryClient();
  const latest = useRef(unused);
  latest.current = unused;
  useEffect(() => {
    // Leaving: the page unmounts (each conversation has its own). Strict
    // Mode's rehearsal unmount comes before any send, so it removes nothing.
    return () => {
      if (!latest.current) return;
      latest.current = false;
      void api
        .delete(`/threads/${encodeURIComponent(threadId)}/unused`)
        .then(() => invalidateConversationLists(queryClient))
        .catch(() => undefined);
    };
  }, [threadId, queryClient]);
}
