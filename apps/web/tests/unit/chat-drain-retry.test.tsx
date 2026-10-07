// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { useChatSession } from '../../src/hooks/use-chat-session';
import { drainRetryDelay, fetchRetryingDrain } from '../../src/lib/chat-retry';

/**
 * A server shutting down refuses a new turn with 503 and Retry-After before
 * storing it (v0.11); the client sends it again before showing an error, and
 * a reply the shutdown interrupted says so.
 */
const { queryClient, models } = vi.hoisted(() => ({
  queryClient: { invalidateQueries: vi.fn() },
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
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
let session: ReturnType<typeof useChatSession>;
function Harness() {
  session = useChatSession({ threadId: 'thread', initialMessages: [] });
  return null;
}
const refusal = (retryAfter: string | null = '0') =>
  new Response(
    JSON.stringify({
      error: { code: 'SERVER_RESTARTING', message: 'This server is restarting.' },
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
      },
    },
  );
const reply = () =>
  new Response(
    `${[
      { type: 'start', messageId: 'run' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Answer' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('')}data: [DONE]\n\n`,
    { headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' } },
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('sending during a server restart', () => {
  it('sends a refused turn again, once, without duplicating the message', async () => {
    const answers = [refusal(), reply()];
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => answers.shift()!);
    vi.stubGlobal('fetch', fetch);
    await act(() => root.render(<Harness />));
    await act(() => session.send('Question'));
    expect(fetch).toHaveBeenCalledTimes(2);
    // The same request both times: the server stored nothing the first time.
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(session.messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Answer',
      state: 'done',
    });
  });

  it('shows the refusal after two retries', async () => {
    const fetch = vi.fn(async () => refusal());
    vi.stubGlobal('fetch', fetch);
    await act(() => root.render(<Harness />));
    await act(() => session.send('Question'));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(session.status).toBe('error');
    expect(session.error?.message).toContain('restarting');
  });

  it('does not repeat a 503 that is not a refusal to try again', async () => {
    const fetch = vi.fn(async () => refusal(null));
    vi.stubGlobal('fetch', fetch);
    await act(() => root.render(<Harness />));
    await act(() => session.send('Question'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('drainRetryDelay', () => {
  const with503 = (value: string) =>
    new Response(null, { status: 503, headers: { 'retry-after': value } });
  it('reads seconds and dates, capped at five seconds', () => {
    expect(drainRetryDelay(with503('1'))).toBe(1_000);
    expect(drainRetryDelay(with503('120'))).toBe(5_000);
    expect(drainRetryDelay(with503(new Date(Date.now() + 2_000).toUTCString()))).toBeLessThan(
      2_001,
    );
    expect(drainRetryDelay(with503('soon'))).toBeNull();
    expect(drainRetryDelay(new Response(null, { status: 502 }))).toBeNull();
  });
  it('never repeats a body it cannot send again, or a GET', async () => {
    const send = vi.fn(async () => refusal());
    await fetchRetryingDrain(send, '/api/chat', { method: 'POST', body: new Blob(['x']) });
    await fetchRetryingDrain(send, '/api/chat/thread/stream', { method: 'GET' });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('stops waiting when the send is abandoned', async () => {
    const abort = new AbortController();
    const send = vi.fn(async () => refusal('1'));
    const sending = fetchRetryingDrain(send, '/api/chat', {
      method: 'POST',
      body: '{}',
      signal: abort.signal,
    });
    abort.abort(new DOMException('Conversation changed', 'AbortError'));
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('an interrupted reply', () => {
  const saved = (metadata: Record<string, unknown>): UIMessage[] => [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Half an' }], metadata },
  ];
  it('says why it stopped, alongside Retry', async () => {
    await act(() =>
      root.render(
        <MessageList
          messages={saved({
            status: 'cancelled',
            errorMessage: 'This reply was interrupted because the server writing it stopped.',
          })}
          streaming={false}
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[role="note"]')?.textContent).toContain('interrupted');
    expect(container.querySelector('button[aria-label="Retry"]')).not.toBeNull();
  });
  it('says nothing for a reply the person stopped', async () => {
    await act(() =>
      root.render(
        <MessageList
          messages={saved({ status: 'cancelled', errorMessage: null })}
          streaming={false}
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[role="note"]')).toBeNull();
  });
});
