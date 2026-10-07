import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import {
  noteRemovedConversation,
  removedConversation,
  takeRemovalToConfirm,
} from '~/lib/unused-conversation';

const unusedPath = (threadId: string) => `/threads/${encodeURIComponent(threadId)}/unused`;

/**
 * Removes a conversation left unused when the person leaves it (#234, #266).
 *
 * The new-chat page creates the conversation before handing it its first
 * message. When that message is refused before it is saved (a server
 * restarting, a rate limit), the text goes back to the composer and the
 * person can send it again here; but if they leave instead, the empty "New
 * Chat" stayed in their history until the daily cleanup. While `unused` is
 * true, leaving asks the server to remove it; the server removes it only if
 * it is still untitled and without a message, so a send accepted meanwhile
 * is safe.
 *
 * Leaving is either for another page in the app (this page unmounts) or out
 * of it: closing the tab, reloading, going to another site (`pagehide`). The
 * second is sent with `keepalive`, so it outlives the page, and noted for
 * this tab, so a reload (or Back, from the browser's page cache) opens a new
 * chat with the unsent text rather than a conversation that is gone.
 */
export function useRemoveUnusedConversation(
  threadId: string,
  unused: boolean,
  context: { draft: string; projectId: string | null },
) {
  const queryClient = useQueryClient();
  const latest = useRef(unused);
  latest.current = unused;
  const leaving = useRef(context);
  leaving.current = context;
  useEffect(() => {
    const path = unusedPath(threadId);
    const leavePage = () => {
      if (!latest.current) return;
      latest.current = false;
      noteRemovedConversation({ threadId, ...leaving.current });
      void api.delete(path, { keepalive: true }).catch(() => undefined);
    };
    // Back to this page from the browser's page cache, after the conversation
    // was removed: load it again, which opens a new chat with the text.
    const showPage = (event: PageTransitionEvent) => {
      if (event.persisted && removedConversation(threadId)) window.location.reload();
    };
    window.addEventListener('pagehide', leavePage);
    window.addEventListener('pageshow', showPage);
    // Leaving for another page in the app: this page unmounts (each
    // conversation has its own). Strict Mode's rehearsal unmount comes before
    // any send, so it removes nothing.
    return () => {
      window.removeEventListener('pagehide', leavePage);
      window.removeEventListener('pageshow', showPage);
      if (!latest.current) return;
      latest.current = false;
      void api
        .delete(path)
        .then(() => invalidateConversationLists(queryClient))
        .catch(() => undefined);
    };
  }, [threadId, queryClient]);
}

/**
 * In the sidebar, after a reload opened a new chat in place of a removed
 * conversation (#266): removes it again (the server keeps it if it is in use,
 * and answers `removed: false` if it is gone) and refreshes the lists, which
 * may have been read before the request sent by the closing page arrived.
 */
export function useConfirmRemovedConversation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const threadId = takeRemovalToConfirm();
    if (!threadId) return;
    void api
      .delete(unusedPath(threadId))
      .then(() => invalidateConversationLists(queryClient))
      .catch(() => undefined);
  }, [queryClient]);
}
