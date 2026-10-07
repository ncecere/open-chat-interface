// @vitest-environment happy-dom
import type { ThreadSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadList } from '../../src/components/layout/thread-list';
import { AUTO_RETRY_MS } from '../../src/hooks/use-auto-retry';
import { invalidateConversationLists } from '../../src/lib/conversation-cache';

/**
 * A new chat's first reply cut off by an outage (#249), through the sidebar's
 * real query, QueryClient (with the app's one retry) and API client. The
 * reply's end refreshes the conversation lists, as useChatSession does, but
 * the server is down, so that refresh fails; the list then said "New Chat"
 * until a reload. Only the router is a stand-in.
 */
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ threadId: 'outage-thread' }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const NOW = new Date().toISOString();
const TITLE = 'Walk4 outage2: list 15 numbered facts about kingfishers, one';
const server = { down: false, title: 'New Chat', listCalls: 0 };

function summary(title: string): ThreadSummary {
  return {
    id: 'outage-thread',
    title,
    pinned: false,
    archived: false,
    temporary: false,
    expiresAt: null,
    parentThreadId: null,
    branchedFromMessageId: null,
    projectId: null,
    lastMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(server, { down: false, title: 'New Chat', listCalls: 0 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      // The proxy's answer while the API restarts.
      if (server.down) return new Response('Bad gateway', { status: 502 });
      if (path === '/api/me') return Response.json({ user: { id: 'me' }, features: {} });
      if (path === '/api/threads') {
        server.listCalls += 1;
        return Response.json({ threads: [summary(server.title)] });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("picks up a new chat's title by itself once the server is back", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ThreadList />
      </QueryClientProvider>,
    ),
  );
  await advance(10);
  expect(container.textContent).toContain('New Chat');

  // The first reply's stream breaks: the server is unreachable, and the
  // lists' refresh at the reply's end (and its one retry) fails.
  server.down = true;
  server.title = TITLE;
  await act(async () => {
    void invalidateConversationLists(client);
  });
  await advance(2_000);
  expect(container.textContent).toContain('New Chat');

  // About 25 seconds later the server answers again; nobody reloads.
  await advance(25_000);
  server.down = false;
  const before = server.listCalls;
  await advance(AUTO_RETRY_MS);
  expect(server.listCalls).toBeGreaterThan(before);
  expect(container.textContent).toContain(TITLE);
  expect(container.textContent).not.toContain('New Chat');
});
