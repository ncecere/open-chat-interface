import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/**
 * A key for the new-chat page that changes each time New Chat is chosen while
 * that page is already open (#208). The router does not remount a route for
 * a navigation to where it already is, so the composer kept its draft, its
 * uploads and the red chips of failed ones; keyed on this, the page starts
 * afresh, as it does when New Chat is chosen from a conversation.
 *
 * Every way to New Chat (the sidebar and top-bar buttons, the shortcut, the
 * command palette, the logo) navigates to `/`, and a navigation to the same
 * address only reloads the route, with the address unchanged.
 */
export function useNewChatKey(): number {
  const router = useRouter();
  const [key, setKey] = useState(0);
  useEffect(
    () =>
      router.subscribe('onBeforeNavigate', (event) => {
        if (!event.hrefChanged && event.toLocation.pathname === '/') setKey((value) => value + 1);
      }),
    [router],
  );
  return key;
}
