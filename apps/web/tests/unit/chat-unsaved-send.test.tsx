// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNSAVED_MESSAGE_TEXT } from '../../src/hooks/use-chat-session';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * A message sent while the database is away (#326), with the real chat page,
 * chat session, AI SDK, query cache and API client, against a network
 * answering as the API does: `500` with `X-OCI-Retryable`, and
 * `X-OCI-Message-Saved: no` when the request failed before the message could
 * be stored.
 *
 * Only 4xx and 503 counted as "refused before it was saved", so the text
 * left the message box and stayed on screen as a sent bubble that was never
 * stored: "Reload saved messages" then removed it, and the text was gone.
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
// The bubbles, as text.
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: ({ messages }: { messages: UIMessage[] }) => (
    <ul data-testid="message-list">
      {messages.map((message) => (
        <li key={message.id}>
          {message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
        </li>
      ))}
    </ul>
  ),
}));

const threadId = 'thread';
const text = 'Walk7 send during outage (s3db2): reply with one word.';
const earlier: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Earlier question' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Earlier answer' }],
    metadata: { status: 'complete' },
  },
];
const LOST = {
  error: {
    code: 'INTERNAL_ERROR',
    message:
      'The connection to the database was interrupted. Try again; if you were saving something, check whether it was saved first.',
    retryable: true,
  },
};
const NOT_SENT =
  'The connection to the database was interrupted, so your message was not sent. Send it again in a moment.';
const LOST_NOT_SENT = { error: { ...LOST.error, message: NOT_SENT } };
/** The message, stored, with the reply that could not start. */
const storedTurn: UIMessage[] = [
  { id: 'stored', role: 'user', parts: [{ type: 'text', text }] },
  {
    id: 'reply',
    role: 'assistant',
    parts: [],
    metadata: {
      status: 'error',
      errorMessage: 'The response could not be started. Please try again.',
    },
  },
];

let sendAnswer: () => Response;
/** The messages the page opens with. */
let initial: UIMessage[];
/** What each reload of the saved messages answers, in turn; the last repeats. */
let reloads: (() => Response)[];
let loads: number;
let requests: { method: string; path: string }[];
let container: HTMLDivElement;
let root: Root;

const lostConnection = (body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, {
    status: 500,
    headers: { 'x-oci-retryable': 'database-connection', 'retry-after': '1', ...extra },
  });
const history = (messages: UIMessage[]) => () =>
  Response.json({
    thread: { id: threadId, temporary: false, expiresAt: null },
    messages,
    replies: [],
    page: { olderCursor: null, newerCursor: null, total: messages.length },
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  sessionStorage.clear();
  loads = 0;
  initial = earlier;
  reloads = [history(earlier)];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const method = init?.method?.toUpperCase() ?? 'GET';
      requests.push({ method, path });
      if (path === `/api/chat/${threadId}/messages`) {
        // The page's own load, then the reloads.
        if (loads++ === 0) return history(initial)();
        return (reloads.length > 1 ? reloads.shift()! : reloads[0]!)();
      }
      if (path === '/api/chat' && method === 'POST') return sendAnswer();
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

type ComposerProps = { value: string; onChange: (value: string) => void; onSubmit: () => void };
const composer = () => mocks.composer.mock.lastCall?.[0] as ComposerProps;
const bubbles = () =>
  [...container.querySelectorAll('[data-testid="message-list"] li')].map((li) => li.textContent);
const alertText = () => container.querySelector('[role="alert"]')?.textContent;
const unusedRemovals = () =>
  requests.filter((request) => request.path === `/api/threads/${threadId}/unused`);

async function openPage() {
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
  await wait(0);
}
async function sendInOpenConversation() {
  await openPage();
  expect(bubbles()).toEqual(['Earlier question', 'Earlier answer']);
  await act(async () => composer().onChange(text));
  await act(async () => {
    composer().onSubmit();
    await vi.advanceTimersByTimeAsync(0);
  });
}
/** The new-chat page created the conversation and handed it the first message. */
async function sendFirstMessageOfNewChat() {
  initial = [];
  sessionStorage.setItem('oci.pendingThreadId', threadId);
  sessionStorage.setItem('oci.pendingPrompt', text);
  sessionStorage.setItem('oci.pendingModel', 'model');
  await openPage();
  await wait(0);
  expect(requests.filter((request) => request.path === '/api/chat')).toHaveLength(1);
}
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** The person goes to another page in the app: this one unmounts. */
async function leave() {
  await act(async () => root.render(null));
  await wait(0);
}

describe('in an existing conversation', () => {
  it('keeps the text in the message box when the server says the message was not stored', async () => {
    sendAnswer = () => lostConnection(LOST_NOT_SENT, { 'x-oci-message-saved': 'no' });
    await sendInOpenConversation();
    // Before: an empty message box, and the message shown as sent.
    expect(composer().value).toBe(text);
    expect(bubbles()).toEqual(['Earlier question', 'Earlier answer']);
    expect(alertText()).toBe(NOT_SENT);
    // Nothing of it was saved: no saved messages to reload for it.
    expect(container.textContent).not.toContain('Reload saved messages');
  });

  it('checks the saved messages when it may have been stored, and gives the text back when it was not', async () => {
    sendAnswer = () => lostConnection(LOST);
    // The database is still away at the first check, back at the second.
    reloads = [() => lostConnection(LOST), history(earlier)];
    await sendInOpenConversation();
    // Not known yet: shown as sent while the saved messages are checked.
    expect(bubbles()).toContain(text);
    expect(composer().value).toBe('');
    await wait(10_000);
    // Before: the empty message box, and the bubble stayed on screen as sent.
    expect(composer().value).toBe(text);
    expect(bubbles()).toEqual(['Earlier question', 'Earlier answer']);
    expect(alertText()).toBe(UNSAVED_MESSAGE_TEXT);
    expect(container.textContent).not.toContain('Reload saved messages');
  });

  it('keeps a message the saved messages show was stored', async () => {
    sendAnswer = () => lostConnection(LOST);
    reloads = [history([...earlier, ...storedTurn])];
    await sendInOpenConversation();
    await wait(10_000);
    expect(composer().value).toBe('');
    expect(bubbles()).toEqual(['Earlier question', 'Earlier answer', text, '']);
    expect(container.textContent).not.toContain(UNSAVED_MESSAGE_TEXT);
  });

  it('checks the saved messages when the connection is lost with no answer', async () => {
    sendAnswer = () => {
      throw new TypeError('Failed to fetch');
    };
    await sendInOpenConversation();
    await wait(10_000);
    // Before: the bubble stayed, and reloading the saved messages lost the text.
    expect(composer().value).toBe(text);
    expect(bubbles()).toEqual(['Earlier question', 'Earlier answer']);
    expect(alertText()).toBe(UNSAVED_MESSAGE_TEXT);
  });

  it('puts the text back before anything typed while the saved messages were checked', async () => {
    sendAnswer = () => lostConnection(LOST);
    reloads = [() => lostConnection(LOST), history(earlier)];
    await sendInOpenConversation();
    await act(async () => composer().onChange('Something else'));
    await wait(10_000);
    expect(composer().value).toBe(`${text}\n\nSomething else`);
    expect(bubbles()).toEqual(['Earlier question', 'Earlier answer']);
    expect(alertText()).toBe(UNSAVED_MESSAGE_TEXT);
  });
});

// The new-chat page creates the conversation before its first message is sent
// (#161, #234, #266): one left empty is removed when the person leaves it.
describe("in a new chat's first message", () => {
  it('keeps the text, offers nothing to reload, and removes the empty conversation when left', async () => {
    sendAnswer = () => lostConnection(LOST_NOT_SENT, { 'x-oci-message-saved': 'no' });
    await sendFirstMessageOfNewChat();
    expect(composer().value).toBe(text);
    expect(bubbles()).toEqual([]);
    expect(alertText()).toBe(NOT_SENT);
    expect(container.textContent).not.toContain('Reload saved messages');
    await leave();
    expect(unusedRemovals()).toEqual([
      { method: 'DELETE', path: `/api/threads/${threadId}/unused` },
    ]);
  });

  it('gives the text back once the saved messages show it was not stored, and removes the empty conversation when left', async () => {
    sendAnswer = () => lostConnection(LOST);
    reloads = [() => lostConnection(LOST), history([])];
    await sendFirstMessageOfNewChat();
    expect(bubbles()).toEqual([text]);
    await wait(10_000);
    expect(composer().value).toBe(text);
    expect(bubbles()).toEqual([]);
    expect(alertText()).toBe(UNSAVED_MESSAGE_TEXT);
    expect(container.textContent).not.toContain('Reload saved messages');
    await leave();
    expect(unusedRemovals()).toHaveLength(1);
  });

  it('keeps a stored first message, and the conversation with it', async () => {
    sendAnswer = () => lostConnection(LOST);
    reloads = [history(storedTurn)];
    await sendFirstMessageOfNewChat();
    await wait(10_000);
    expect(composer().value).toBe('');
    expect(bubbles()).toEqual([text, '']);
    expect(container.textContent).not.toContain(UNSAVED_MESSAGE_TEXT);
    await leave();
    expect(unusedRemovals()).toHaveLength(0);
  });
});
