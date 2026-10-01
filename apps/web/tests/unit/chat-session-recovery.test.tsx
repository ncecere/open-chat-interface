// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { act, StrictMode, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';

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

let root: Root;
let session: ReturnType<typeof useChatSession>;
function Harness({ id = 'thread', messages = [] }: { id?: string; messages?: UIMessage[] }) {
  session = useChatSession({ threadId: id, initialMessages: messages });
  return null;
}
function AutoHandover({ branch }: { branch: boolean }) {
  const current = useChatSession({
    threadId: 'thread',
    initialMessages: branch ? [saved[0]!] : [],
  });
  session = current;
  const sent = useRef(false);
  const { selectedModel, send, regenerate } = current;
  useEffect(() => {
    if (sent.current || !selectedModel) return;
    sent.current = true;
    if (branch) void regenerate({ messageId: 'stored-user' });
    else void send('Question');
  }, [branch, selectedModel, send, regenerate]);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(chunks: unknown[]) {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' },
    },
  );
}
const healthy = [
  { type: 'start', messageId: 'run' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'Answer' },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: 'stop' },
];
const saved: UIMessage[] = [
  { id: 'stored-user', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
  {
    id: 'run',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Saved answer' }],
    metadata: { status: 'complete' },
  },
];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('does not reconnect an idle conversation or refetch full history after a healthy reply', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(healthy));
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness />));
  expect(fetch).not.toHaveBeenCalled();
  await act(() => session.send('Question'));
  expect(session.status).toBe('ready');
  expect(session.messages.at(-1)?.parts).toContainEqual({
    type: 'text',
    text: 'Answer',
    state: 'done',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/chat');
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).modelSlug).toBe('model');
  expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['threads'] });
});

it('uses the canonical prompt ID for an immediate retry without reloading history', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const accepted = response(healthy);
    accepted.headers.set('X-OCI-Prompt-Message-Id', 'stored-user');
    return accepted;
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness />));
  await act(() => session.send('Question'));
  expect(session.messages[0]?.id).toBe('stored-user');
  await act(() => session.regenerate());
  const retry = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string);
  expect(retry.messages[0].id).toBe('stored-user');
  expect(retry.trigger).toBe('regenerate-message');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('recovers an accepted errored stream through canonical history without losing the next draft', async () => {
  const post = deferred<Response>();
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return post.promise;
    return Response.json({
      thread: { id: 'thread', temporary: false, expiresAt: null },
      messages: saved,
    });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness />));
  let sending!: Promise<void>;
  await act(() => {
    sending = session.send('Question');
  });
  await act(() => session.setDraft('My next draft'));
  await act(async () => {
    post.resolve(
      response([
        { type: 'start', messageId: 'run' },
        { type: 'error', errorText: 'Live replay is no longer available' },
      ]),
    );
    await sending;
  });
  expect(session.messages).toEqual(saved);
  expect(session.draft).toBe('My next draft');
  expect(session.error).toBeUndefined();
  expect(session.recovery.remotePending).toBe(false);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/chat/thread/messages')).toHaveLength(1);
});

it('does not erase an unaccepted failed prompt with an automatic history refresh', async () => {
  const fetch = vi.fn(async () => new Response('Request rejected', { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness />));
  await act(() => session.send('Question'));
  expect(session.status).toBe('error');
  expect(session.messages.at(-1)?.parts).toContainEqual({ type: 'text', text: 'Question' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not let an older manual refresh erase a newer rejected prompt', async () => {
  const oldRead = deferred<Response>();
  let reads = 0;
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response('Request rejected', { status: 400 });
    reads++;
    if (reads === 1) return oldRead.promise;
    return Response.json({
      thread: { id: 'thread', temporary: false, expiresAt: null },
      messages: [],
    });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness />));
  await act(() => session.recovery.recover());
  await act(() => session.send('Keep this rejected prompt'));
  await act(async () => {
    oldRead.resolve(
      Response.json({ thread: { id: 'thread', temporary: false, expiresAt: null }, messages: [] }),
    );
  });
  expect(session.status).toBe('error');
  expect(session.messages.at(-1)?.parts).toContainEqual({
    type: 'text',
    text: 'Keep this rejected prompt',
  });
  expect(reads).toBe(1);
});

it('stops a reconnect still waiting for headers, then recovers the saved cancellation', async () => {
  let reconnectSignal: AbortSignal | undefined;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/stream') && init?.method === 'GET') {
      reconnectSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Stopped', 'AbortError')),
          { once: true },
        );
      });
    }
    if (init?.method === 'DELETE') return Response.json({ cancelled: true });
    return Response.json({
      thread: { id: 'thread', temporary: false, expiresAt: null },
      messages: [{ id: 'run', role: 'assistant', parts: [], metadata: { status: 'cancelled' } }],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const pending: UIMessage[] = [
    { id: 'run', role: 'assistant', parts: [], metadata: { status: 'streaming' } },
  ];
  await act(() => root.render(<Harness messages={pending} />));
  expect(session.recovery.resuming).toBe(true);
  await act(() => session.stop());
  expect(reconnectSignal?.aborted).toBe(true);
  expect(session.recovery.resuming).toBe(false);
  expect(session.streaming).toBe(false);
  expect(session.messages.at(-1)?.metadata).toEqual({ status: 'cancelled' });
});

it.each([false, true])(
  'keeps a one-shot handover alive through StrictMode cleanup (branch=%s)',
  async (branch) => {
    localStorage.setItem('oci.model', 'model');
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Already aborted', 'AbortError');
      return response(healthy);
    });
    vi.stubGlobal('fetch', fetch);
    await act(() =>
      root.render(
        <StrictMode>
          <AutoHandover branch={branch} />
        </StrictMode>,
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(session.messages.at(-1)?.role).toBe('assistant');
    expect(session.messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Answer',
      state: 'done',
    });
    expect(session.status).toBe('ready');
  },
);

it('aborts an already-connected replay reader on navigation, without DELETE', async () => {
  const aborted = vi.fn();
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of healthy.slice(0, 3))
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted();
            controller.error(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    return new Response(body, {
      headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const pending: UIMessage[] = [
    { id: 'run', role: 'assistant', parts: [], metadata: { status: 'streaming' } },
  ];
  await act(() => root.render(<Harness key="old" messages={pending} />));
  expect(session.status).toBe('streaming');
  await act(() => root.render(<Harness key="new" id="next" />));
  expect(aborted).toHaveBeenCalledOnce();
  expect(session.messages).toEqual([]);
  expect(session.status).toBe('ready');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
});

it('closes a connected browser replay even when the explicit server stop fails', async () => {
  const pending: UIMessage[] = [
    { id: 'run', role: 'assistant', parts: [], metadata: { status: 'streaming' } },
  ];
  const aborted = vi.fn();
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') throw new TypeError('Injected DELETE failure');
    if (String(url).endsWith('/messages'))
      return Response.json({
        thread: { id: 'thread', temporary: false, expiresAt: null },
        messages: pending,
      });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of healthy.slice(0, 3))
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted();
            controller.error(new DOMException('Stopped', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    return new Response(body, {
      headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness messages={pending} />));
  expect(session.status).toBe('streaming');
  await act(() => session.stop());
  expect(aborted).toHaveBeenCalledOnce();
  expect(session.recovery.resuming).toBe(false);
  expect(session.recovery.remotePending).toBe(true); // A local abort is not proof the producer stopped.
  expect(session.streaming).toBe(true); // Stop remains available for another explicit attempt.
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1);
  expect(session.messages.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: 'text', text: 'Answer' }),
  );
});

it('cancels late reconnect bodies after navigation without stopping the server producer', async () => {
  const headers = deferred<Response>();
  const cancelled = vi.fn();
  const fetch = vi.fn(() => headers.promise);
  vi.stubGlobal('fetch', fetch);
  const pending: UIMessage[] = [
    { id: 'run', role: 'assistant', parts: [], metadata: { status: 'streaming' } },
  ];
  await act(() => root.render(<Harness key="old" messages={pending} />));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Harness key="new" id="next" />));
  await act(async () => {
    headers.resolve(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' },
      }),
    );
    await headers.promise;
  });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(session.messages).toEqual([]);
  expect(session.status).toBe('ready');
  expect(fetch).toHaveBeenCalledTimes(1); // No DELETE and no stale history request.
});
