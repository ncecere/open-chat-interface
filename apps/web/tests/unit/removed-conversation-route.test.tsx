// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConfirmRemovedConversation } from '../../src/hooks/use-unused-conversation';
import { validateChatHomeSearch } from '../../src/lib/chat-search-params';
import {
  noteRemovedConversation,
  peekRestoredDraft,
  takeRemovedConversation,
} from '../../src/lib/unused-conversation';
import { redirectRemovedConversation } from '../../src/lib/unused-conversation-route';

/**
 * A reload of a conversation the closing page removed (#266): the real
 * router, with the conversation page's real guard, lands on a new chat (in
 * the conversation's project) with the unsent text, once. Any other
 * conversation opens as usual.
 */
function routerAt(path: string) {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    validateSearch: validateChatHomeSearch,
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: '/chat/$threadId',
    beforeLoad: ({ params }) => redirectRemovedConversation(params.threadId),
  });
  return createRouter({
    routeTree: root.addChildren([home, chat]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

const project = '6f0a5f8e-1c2b-4d3e-8f9a-0b1c2d3e4f5a';
const removedId = '0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it('opens a new chat in its project, with the unsent text, in place of the removed one', async () => {
  noteRemovedConversation({ threadId: removedId, projectId: project, draft: 'Walk4 reload' });
  const router = routerAt(`/chat/${removedId}`);
  await router.load();
  expect(router.state.location.pathname).toBe('/');
  expect(router.state.location.search).toEqual({ project });
  expect(peekRestoredDraft()).toBe('Walk4 reload');

  // Only once: the note is used up.
  const again = routerAt(`/chat/${removedId}`);
  await again.load();
  expect(again.state.location.pathname).toBe(`/chat/${removedId}`);
});

it('opens any other conversation as usual', async () => {
  noteRemovedConversation({ threadId: removedId, projectId: null, draft: 'x' });
  const router = routerAt('/chat/another');
  await router.load();
  expect(router.state.location.pathname).toBe('/chat/another');
  expect(peekRestoredDraft()).toBe('');
});

it('asks again, and refreshes the sidebar, once the new chat has opened', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return Response.json({ removed: false });
    }),
  );
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  function Sidebar() {
    useConfirmRemovedConversation();
    return null;
  }
  noteRemovedConversation({ threadId: removedId, projectId: null, draft: '' });
  takeRemovedConversation(removedId);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Sidebar />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['threads'] }));
  expect(requests).toEqual([`DELETE /api/threads/${removedId}/unused`]);
  // Once: a sidebar mounted again asks nothing.
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Sidebar />
      </QueryClientProvider>,
    ),
  );
  expect(requests).toHaveLength(1);
  await act(async () => root.unmount());
});
