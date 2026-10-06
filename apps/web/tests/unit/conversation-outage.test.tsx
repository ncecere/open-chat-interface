// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTO_RETRY_MS } from '../../src/hooks/use-auto-retry';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * Opening a conversation during a database outage of about a minute (#233).
 * The page's real query, QueryClient and API client run against a network
 * that answers 500 as the API did while PostgreSQL was away, then recovers.
 * "Could not load conversation" stayed after the outage until Retry.
 * Only the chat session and the heavy children of a loaded page are stand-ins.
 */
const mocks = vi.hoisted(() => ({ messageList: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../../src/hooks/use-chat-session', () => ({
  useChatSession: ({ initialMessages }: { initialMessages: UIMessage[] }) => ({
    messages: initialMessages,
    draft: '',
    setDraft: vi.fn(),
    streaming: false,
    status: 'ready',
    recovery: {
      resuming: false,
      remotePending: false,
      refreshing: false,
      unavailable: false,
      error: null,
      recover: vi.fn(),
      waitForServer: vi.fn(),
    },
    error: undefined,
    models: [],
    selectedModel: undefined,
    selectModel: vi.fn(),
    effort: 'instant',
    setEffort: vi.fn(),
    webSearch: false,
    setWebSearch: vi.fn(),
    features: {},
    attachments: { items: [], upload: vi.fn(), remove: vi.fn() },
    send: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/hooks/use-threads', () => ({
  useBranchMessage: () => ({ mutateAsync: vi.fn() }),
  useForkMessage: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: () => <textarea aria-label="Message composer" />,
}));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: (props: { messages: UIMessage[] }) => {
    mocks.messageList(props);
    return <div data-testid="message-list" />;
  },
}));

const threadId = 'outage-thread';
const server = { down: true, historyCalls: 0 };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(server, { down: true, historyCalls: 0 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === `/api/chat/${threadId}/messages`) {
        server.historyCalls += 1;
        if (server.down)
          return Response.json(
            { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
            { status: 500 },
          );
        return Response.json({
          thread: { id: threadId, temporary: false, expiresAt: null },
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Saved question' }] }],
          replies: [],
          page: { olderCursor: null, newerCursor: null, total: 1 },
        });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('loads the conversation by itself once the outage is over', async () => {
  // The app's own default: one retry.
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TemporaryChatProvider>
          <ChatThreadPage threadId={threadId} />
        </TemporaryChatProvider>
      </QueryClientProvider>,
    ),
  );
  // The page's own retries (after 1 s and 2 s) meet the outage too.
  await advance(3_500);
  expect(container.textContent).toContain('Could not load conversation');
  expect(container.textContent).toContain('Trying again by itself');
  const failed = server.historyCalls;

  // A minute later the database is back; nobody presses Retry.
  await advance(60_000);
  expect(server.historyCalls).toBeGreaterThan(failed);
  server.down = false;
  await advance(AUTO_RETRY_MS);
  expect(container.textContent).not.toContain('Could not load conversation');
  expect(container.querySelector('[data-testid="message-list"]')).not.toBeNull();
  expect(mocks.messageList).toHaveBeenLastCalledWith(
    expect.objectContaining({
      messages: [expect.objectContaining({ id: 'm1' })],
    }),
  );
});
