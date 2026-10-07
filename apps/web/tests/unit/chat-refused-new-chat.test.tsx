// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * A new chat whose first message a restarting server refuses (#234). The
 * new-chat page has created the conversation and handed it the message; the
 * page sends it with the real chat session, AI SDK, query and API client,
 * against a network answering as a draining replica does (503, Retry-After).
 * The text came back to the composer (#161), but "Reload saved messages" was
 * offered though nothing was saved, and the empty "New Chat" stayed in the
 * history after the person left it.
 */
const mocks = vi.hoisted(() => ({
  composer: vi.fn(),
  models: [
    {
      slug: 'model',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: mocks.models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/hooks/use-threads', () => ({
  useBranchMessage: () => ({ mutateAsync: vi.fn() }),
  useForkMessage: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: { value: string }) => {
    mocks.composer(props);
    return <textarea aria-label="Message composer" readOnly value={props.value} />;
  },
}));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

const threadId = 'new-chat';
const text = 'Walk3 drain send: reply with one word.';
let requests: { method: string; path: string }[];
let accept: boolean;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  sessionStorage.clear();
  // What the new-chat page leaves for the conversation it created.
  sessionStorage.setItem('oci.pendingThreadId', threadId);
  sessionStorage.setItem('oci.pendingPrompt', text);
  sessionStorage.setItem('oci.pendingModel', 'model');
  requests = [];
  accept = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const method = init?.method?.toUpperCase() ?? 'GET';
      requests.push({ method, path });
      if (path === `/api/chat/${threadId}/messages`)
        return Response.json({
          thread: { id: threadId, temporary: false, expiresAt: null },
          messages: [],
          replies: [],
          page: { olderCursor: null, newerCursor: null, total: 0 },
        });
      if (path === '/api/chat' && method === 'POST' && !accept)
        return Response.json(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'This server is restarting. Send your message again in a moment.',
            },
          },
          { status: 503, headers: { 'retry-after': '1' } },
        );
      if (path === '/api/chat' && method === 'POST')
        return new Response(
          [
            { type: 'start', messageId: 'reply' },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Word.' },
            { type: 'text-end', id: 't' },
            { type: 'finish' },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .concat('data: [DONE]\n\n')
            .join(''),
          {
            headers: {
              'content-type': 'text/event-stream',
              'x-vercel-ai-ui-message-stream': 'v1',
              'X-OCI-Chat-Run-Id': 'reply',
            },
          },
        );
      if (path === `/api/threads/${threadId}/unused` && method === 'DELETE')
        return Response.json({ removed: true });
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
  sessionStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openNewChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TemporaryChatProvider>
          <ChatThreadPage threadId={threadId} />
        </TemporaryChatProvider>
      </QueryClientProvider>,
    ),
  );
  // The hand-over is sent, refused, and sent again twice after Retry-After.
  for (let step = 0; step < 4; step++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
}
const unusedRemovals = () =>
  requests.filter((request) => request.path === `/api/threads/${threadId}/unused`);
const posts = () => requests.filter((request) => request.path === '/api/chat');

it('offers no saved messages to reload, and removes the empty conversation when left', async () => {
  await openNewChat();
  expect(posts()).toHaveLength(3);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'This server is restarting. Send your message again in a moment.',
  );
  expect(mocks.composer).toHaveBeenLastCalledWith(expect.objectContaining({ value: text }));
  // Nothing was saved.
  expect(container.textContent).not.toContain('Reload saved messages');
  expect(unusedRemovals()).toHaveLength(0);

  // The person leaves for another page (the conversation's page unmounts).
  await act(async () => root.render(null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(unusedRemovals()).toEqual([{ method: 'DELETE', path: `/api/threads/${threadId}/unused` }]);
});

it('keeps a conversation whose message is sent again and accepted', async () => {
  await openNewChat();
  accept = true;
  const props = mocks.composer.mock.lastCall?.[0] as { onSubmit: () => Promise<void> };
  await act(async () => {
    await props.onSubmit();
  });
  expect(posts()).toHaveLength(4);
  await act(async () => root.render(null));
  expect(unusedRemovals()).toHaveLength(0);
});
