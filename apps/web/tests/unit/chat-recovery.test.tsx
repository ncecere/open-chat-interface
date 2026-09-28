// @vitest-environment happy-dom
import { Chat, useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatConnectionScope, useChatRecovery } from '../../src/hooks/use-chat-recovery';
import { useChatSession } from '../../src/hooks/use-chat-session';
import { ApiError } from '../../src/lib/api-client';
import type { ChatHistory } from '../../src/lib/chat-history';

// Only external IO/catalog dependencies are replaced. Chat, useChat, transport,
// history validation, recovery, session ownership and attachment state are real.
const { getHistory, invalidateQueries, models } = vi.hoisted(() => ({
  getHistory: vi.fn<(path: string, options?: Pick<RequestInit, 'signal'>) => Promise<unknown>>(),
  invalidateQueries: vi.fn(),
  models: [
    {
      slug: 'test-model',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-client')>();
  return { ...actual, api: { ...actual.api, get: getHistory } };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function messages(text: string, status = 'complete'): UIMessage[] {
  return [
    { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    {
      id: 'assistant-1',
      role: 'assistant',
      metadata: { status },
      parts: [{ type: 'text', text }],
    },
  ];
}
function history(saved = messages('Canonical answer'), threadId = 'thread'): ChatHistory {
  return { thread: { id: threadId, temporary: false, expiresAt: null }, messages: saved };
}
function sse(runId?: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const headers = new Headers({
    'content-type': 'text/event-stream',
    'x-vercel-ai-ui-message-stream': 'v1',
  });
  if (runId) headers.set('X-OCI-Chat-Run-Id', runId);
  return {
    response: new Response(body, { headers }),
    push(chunk: Record<string, unknown>) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    close() {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}

let root: Root;
let session: ReturnType<typeof useChatSession>;
let core: {
  chat: ReturnType<typeof useChat>;
  recovery: ReturnType<typeof useChatRecovery>;
};
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let clearRun: ReturnType<typeof vi.fn<(id: string) => void>>;
const initialPending = () => {
  const pending = messages('', 'streaming');
  pending[1]!.parts = [];
  return pending;
};

function SessionHarness({
  threadId = 'thread',
  initialMessages = [],
}: {
  threadId?: string;
  initialMessages?: UIMessage[];
}) {
  session = useChatSession({ threadId, initialMessages });
  return null;
}
function CoreHarness({
  sdk,
  scope,
  initialMessages,
  runId = null,
}: {
  sdk: Chat<UIMessage>;
  scope: ChatConnectionScope;
  initialMessages: UIMessage[];
  runId?: string | null;
}) {
  const chat = useChat({ chat: sdk, resume: false });
  const recovery = useChatRecovery({
    threadId: sdk.id,
    initialMessages,
    chat,
    scope,
    runId,
    clearRun,
  });
  core = { chat, recovery };
  return null;
}
function makeSdk(initialMessages: UIMessage[] = [], threadId = 'thread') {
  return new Chat<UIMessage>({
    id: threadId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      fetch: network,
      prepareReconnectToStreamRequest: () => ({ api: `/api/chat/${threadId}/stream` }),
    }),
  });
}

// Drain the SDK's promise/ReadableStream jobs without advancing the recovery
// clock. Every pending IO operation is controlled by an explicit deferred gate.
async function settle(action?: () => void) {
  await act(async () => {
    action?.();
    for (let job = 0; job < 100; job++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount(initialMessages: UIMessage[] = []) {
  await settle(() => root.render(<SessionHarness initialMessages={initialMessages} />));
}
function chatPosts() {
  return network.mock.calls.filter(
    ([input, init]) => String(input) === '/api/chat' && init?.method === 'POST',
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  getHistory.mockReset();
  invalidateQueries.mockReset();
  clearRun = vi.fn();
  network = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    throw new Error(`Unexpected network request: ${String(input)}`);
  });
  vi.stubGlobal('fetch', network);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canonical chat recovery with the real AI SDK', () => {
  it('resumes an initial pending row once; GET 204 recovers the terminal saved answer', async () => {
    const saved = history();
    network.mockResolvedValue(new Response(null, { status: 204 }));
    getHistory.mockResolvedValue(saved);

    await mount(initialPending());

    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]?.[0]).toBe('/api/chat/thread/stream');
    expect(network.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getHistory).toHaveBeenCalledExactlyOnceWith('/chat/thread/messages', {
      signal: expect.any(AbortSignal),
    });
    expect(session.messages).toEqual(saved.messages);
    expect(session.status).toBe('ready');
    expect(session.recovery).toMatchObject({
      resuming: false,
      remotePending: false,
      refreshing: false,
      error: null,
    });
    expect(session.streaming).toBe(false);
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledOnce();
    expect(chatPosts()).toHaveLength(0);
  });

  it('recovers canonical content after the SDK consumes a friendly replay error frame', async () => {
    const replay = sse();
    replay.push({ type: 'error', errorText: 'The live stream is no longer available.' });
    replay.close();
    network.mockResolvedValue(replay.response);
    getHistory.mockResolvedValue(history());

    await mount(initialPending());

    expect(network).toHaveBeenCalledOnce();
    expect(getHistory).toHaveBeenCalledOnce();
    expect(session.messages).toEqual(history().messages);
    expect(session.error).toBeUndefined();
    expect(session.status).toBe('ready');
    expect(session.recovery.error).toBeNull();
    expect(session.streaming).toBe(false);
    expect(chatPosts()).toHaveLength(0);
  });

  it('awaits the entire resume promise, not headers, before hydrating saved messages', async () => {
    const headers = deferred<Response>();
    const replay = sse('accepted-replay');
    const saved = history(messages('Replay tail plus canonical suffix'));
    network.mockReturnValue(headers.promise);
    getHistory.mockResolvedValue(saved);
    await mount(initialPending());
    expect(session.recovery.resuming).toBe(true);
    expect(getHistory).not.toHaveBeenCalled();

    await settle(() => {
      replay.push({ type: 'start', messageId: 'assistant-1' });
      replay.push({ type: 'text-start', id: 'text-1' });
      replay.push({ type: 'text-delta', id: 'text-1', delta: 'Replay tail' });
      headers.resolve(replay.response);
    });
    expect(session.status).toBe('streaming');
    expect(session.recovery.resuming).toBe(true);
    await advance(6_000);
    expect(getHistory).not.toHaveBeenCalled();

    await settle(() => {
      replay.push({ type: 'text-end', id: 'text-1' });
      replay.push({ type: 'finish', finishReason: 'stop' });
      replay.close();
    });
    expect(getHistory).toHaveBeenCalledOnce();
    expect(session.messages).toEqual(saved.messages);
    expect(session.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(session.streaming).toBe(false);
    await advance(4_000);
    expect(getHistory).toHaveBeenCalledOnce();
    expect(chatPosts()).toHaveLength(0);
  });

  it('polls pending storage at two seconds, keeps Stop available, and ends on terminal storage', async () => {
    network.mockImplementation(async () => new Response(null, { status: 204 }));
    getHistory.mockResolvedValue(history(initialPending()));
    await mount(initialPending());
    expect(session.status).toBe('ready');
    expect(session.recovery.remotePending).toBe(true);
    expect(session.streaming).toBe(true);

    await advance(1_999);
    expect(getHistory).toHaveBeenCalledOnce();
    await advance(1);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(session.streaming).toBe(true);
    await act(() => session.stop());
    expect(network).toHaveBeenCalledWith('/api/chat/thread/stream', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    expect(session.recovery.remotePending).toBe(true);
    expect(session.streaming).toBe(true);

    getHistory.mockResolvedValue(history(messages('Saved partial answer', 'cancelled')));
    await advance(2_000);
    expect(session.messages).toEqual(
      history(messages('Saved partial answer', 'cancelled')).messages,
    );
    expect(session.recovery.remotePending).toBe(false);
    expect(session.streaming).toBe(false);
    const reads = getHistory.mock.calls.length;
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledTimes(reads);
    expect(chatPosts()).toHaveLength(0);
  });

  it('keeps a partial SSE prefix while canonical polling sees an empty streaming claim', async () => {
    const replay = sse();
    const firstSnapshot = deferred<ChatHistory>();
    const emptyClaim = history(initialPending());
    emptyClaim.messages[1]!.parts = [];
    getHistory.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValue(emptyClaim);
    network.mockResolvedValue(replay.response);
    replay.push({ type: 'start', messageId: 'assistant-1' });
    replay.push({ type: 'text-start', id: 'prefix' });
    replay.push({ type: 'text-delta', id: 'prefix', delta: 'Already visible prefix' });
    await mount(initialPending());
    expect(session.status).toBe('streaming');
    expect(getHistory).not.toHaveBeenCalled();

    await settle(() => {
      replay.push({ type: 'error', errorText: 'The live stream disconnected.' });
      replay.close();
    });
    expect(getHistory).toHaveBeenCalledOnce();
    const partial = session.messages.find((message) => message.id === 'assistant-1');
    expect(partial?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'Already visible prefix' }),
    ]);
    await settle(() => firstSnapshot.resolve(emptyClaim));
    expect(session.messages.find((message) => message.id === 'assistant-1')).toBe(partial);
    expect(session.recovery.remotePending).toBe(true);
    expect(session.streaming).toBe(true);
    await advance(2_000);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(session.messages.find((message) => message.id === 'assistant-1')).toBe(partial);

    getHistory.mockResolvedValue(history(messages('Full canonical answer')));
    await advance(2_000);
    expect(session.messages).toEqual(history(messages('Full canonical answer')).messages);
    expect(session.messages.find((message) => message.id === 'assistant-1')).not.toBe(partial);
    expect(session.streaming).toBe(false);
    expect(session.recovery.error).toBeNull();
    expect(chatPosts()).toHaveLength(0);
  });

  it('does not reconnect or read an idle thread, including a healthy ready SDK with an accepted run', async () => {
    await mount();
    await advance(20_000);
    expect(network).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(session.messages).toEqual([]);
    expect(session.streaming).toBe(false);
    expect(session.recovery).toMatchObject({ resuming: false, remotePending: false, error: null });

    const sdk = makeSdk(messages('Healthy completed response'));
    await settle(() =>
      root.render(
        <CoreHarness
          sdk={sdk}
          scope={{ active: true, request: 1 }}
          initialMessages={sdk.messages}
          runId="healthy-accepted-run"
        />,
      ),
    );
    expect(core.chat.status).toBe('ready');
    await advance(20_000);
    expect(getHistory).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('pauses on a transient canonical failure; explicit Retry preserves draft and an in-flight upload', async () => {
    const upload = deferred<Response>();
    network.mockImplementation(async (input) => {
      if (String(input) === '/api/attachments') return upload.promise;
      return new Response(null, { status: 204 });
    });
    getHistory.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Internal upstream details'));
    await mount(initialPending());
    expect(session.recovery.error).toBe(
      'Could not refresh saved messages. Retry to check the response.',
    );
    expect(session.recovery.unavailable).toBe(false);
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledOnce();

    let uploading!: Promise<void>;
    await settle(() => {
      session.setDraft('Do not discard this next question');
      uploading = session.attachments.upload([
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
      ]);
    });
    const items = session.attachments.items;
    expect(items[0]?.status).toBe('uploading');
    getHistory.mockResolvedValueOnce(history());
    await settle(() => session.recovery.recover());
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(session.messages).toEqual(history().messages);
    expect(session.recovery.error).toBeNull();
    expect(session.streaming).toBe(false);
    expect(session.draft).toBe('Do not discard this next question');
    expect(session.attachments.items).toBe(items);
    expect(
      network.mock.calls.find(([input]) => input === '/api/attachments')?.[1]?.signal?.aborted,
    ).toBe(false);

    await act(async () => {
      upload.resolve(
        Response.json({
          attachments: [
            { id: 'attachment-1', filename: 'notes.txt', mimeType: 'text/plain', url: '/notes' },
          ],
        }),
      );
      await uploading;
    });
    expect(session.attachments.readyIds).toEqual(['attachment-1']);
    expect(chatPosts()).toHaveLength(0);
  });

  it('marks a 404 unavailable and drops remote pending instead of polling or resending', async () => {
    network.mockResolvedValue(new Response(null, { status: 204 }));
    getHistory.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Private server detail'));
    await mount(initialPending());
    expect(session.recovery).toMatchObject({
      unavailable: true,
      remotePending: false,
      refreshing: false,
      error: 'Conversation unavailable',
    });
    expect(session.streaming).toBe(false);
    await act(() => session.send('must not send to an unavailable conversation'));
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledOnce();
    expect(chatPosts()).toHaveLength(0);
  });

  it('rejects stale snapshots when either SDK array identity or request generation changes', async () => {
    const first = deferred<ChatHistory>();
    const second = deferred<ChatHistory>();
    const initial = initialPending();
    const scope = { active: true, request: 0 };
    const sdk = makeSdk(initial);
    network.mockResolvedValue(new Response(null, { status: 204 }));
    getHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await settle(() =>
      root.render(<CoreHarness sdk={sdk} scope={scope} initialMessages={initial} />),
    );
    expect(getHistory).toHaveBeenCalledOnce();

    const newer = messages('Newer SDK state', 'streaming');
    await settle(() => core.chat.setMessages(newer));
    const newerObjects = sdk.messages;
    await settle(() => first.resolve(history()));
    // The real SDK copies the outer array even when an updater returns current.
    // The invariant is that none of the newer message objects/content are replaced.
    expect(sdk.messages).toEqual(newerObjects);
    expect(sdk.messages[0]).toBe(newerObjects[0]);
    expect(sdk.messages[1]).toBe(newerObjects[1]);
    expect(core.recovery.remotePending).toBe(true);
    const baseline = sdk.messages;

    await advance(2_000);
    expect(getHistory).toHaveBeenCalledTimes(2);
    // A send can increment this before the SDK publishes its new message array.
    scope.request++;
    await settle(() => second.resolve(history(messages('Another stale snapshot'))));
    expect(sdk.messages).toBe(baseline);
    expect(core.recovery.remotePending).toBe(true);
    expect(clearRun).not.toHaveBeenCalled();

    const superseded = deferred<ChatHistory>();
    const fresh = deferred<ChatHistory>();
    getHistory.mockReturnValueOnce(superseded.promise).mockReturnValueOnce(fresh.promise);
    await settle(() => core.recovery.recover());
    // Retry increments its epoch synchronously, before React can clean up the
    // old effect. Resolving the old request in this same turn must not apply it.
    await settle(() => {
      core.recovery.recover();
      superseded.resolve(history(messages('Superseded retry')));
    });
    expect(sdk.messages).toBe(baseline);
    await settle(() => fresh.resolve(history(messages('Fresh snapshot'))));
    expect(sdk.messages).toEqual(history(messages('Fresh snapshot')).messages);
    expect(core.recovery.remotePending).toBe(false);
  });

  it('protects an active SDK send from stale hydration and refreshes an accepted run after a stream error', async () => {
    const stale = deferred<ChatHistory>();
    const live = sse('accepted-new-run');
    getHistory
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(history(messages('Saved new answer')));
    network.mockResolvedValue(live.response);
    await mount();
    await settle(() => session.recovery.recover());
    const oldSignal = getHistory.mock.calls[0]?.[1]?.signal;
    let sending!: Promise<void>;
    await settle(() => {
      live.push({ type: 'start', messageId: 'new-assistant' });
      live.push({ type: 'text-start', id: 'new-text' });
      live.push({ type: 'text-delta', id: 'new-text', delta: 'Live new answer' });
      sending = session.send('New question');
    });
    expect(session.status).toBe('streaming');
    expect(oldSignal?.aborted).toBe(true);
    const activeMessages = session.messages;
    await settle(() => stale.resolve(history(messages('Stale answer'))));
    expect(session.messages).toBe(activeMessages);
    expect(getHistory).toHaveBeenCalledOnce();

    await act(async () => {
      live.push({ type: 'error', errorText: 'Stream interrupted. Check the saved response.' });
      live.close();
      await sending;
    });
    await settle();
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(session.messages).toEqual(history(messages('Saved new answer')).messages);
    expect(session.error).toBeUndefined();
    expect(session.recovery.error).toBeNull();
    expect(session.streaming).toBe(false);
    await advance(10_000);
    expect(chatPosts()).toHaveLength(1);
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it('aborts old-thread retrieval and ignores its late failure after changing threads', async () => {
    const stale = deferred<ChatHistory>();
    getHistory
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(history(messages('Next thread'), 'next'));
    await mount();
    await settle(() => session.recovery.recover());
    const signal = getHistory.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await settle(() => root.render(<SessionHarness threadId="next" />));
    expect(signal?.aborted).toBe(true);
    expect(session.messages).toEqual(history(messages('Next thread'), 'next').messages);
    await settle(() => stale.reject(new ApiError(404, 'NOT_FOUND', 'Old thread vanished')));
    expect(session.id).toBe('next');
    expect(session.messages).toEqual(history(messages('Next thread'), 'next').messages);
    expect(session.recovery.unavailable).toBe(false);
    expect(session.recovery.error).toBeNull();
    expect(chatPosts()).toHaveLength(0);
  });

  it('aborts retrieval on unmount and ignores a late successful snapshot even if fetch ignores abort', async () => {
    const stale = deferred<ChatHistory>();
    const sdk = makeSdk();
    const scope = { active: true, request: 0 };
    getHistory.mockReturnValue(stale.promise);
    await settle(() => root.render(<CoreHarness sdk={sdk} scope={scope} initialMessages={[]} />));
    await settle(() => core.recovery.recover());
    const baseline = sdk.messages;
    const signal = getHistory.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    // Rendering null exercises the same hook cleanup without unmounting the test root twice.
    await settle(() => root.render(null));
    expect(signal?.aborted).toBe(true);
    await settle(() => stale.resolve(history()));
    expect(sdk.messages).toBe(baseline);
    expect(clearRun).not.toHaveBeenCalled();
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledOnce();
  });

  it('shares one reconnect across StrictMode effect replay', async () => {
    const reconnect = deferred<Response>();
    network.mockReturnValue(reconnect.promise);
    getHistory.mockResolvedValue(history());
    await settle(() =>
      root.render(
        <StrictMode>
          <SessionHarness initialMessages={initialPending()} />
        </StrictMode>,
      ),
    );
    expect(network).toHaveBeenCalledOnce();
    expect(getHistory).not.toHaveBeenCalled();
    await settle(() => reconnect.resolve(new Response(null, { status: 204 })));
    expect(network).toHaveBeenCalledOnce();
    expect(getHistory).toHaveBeenCalledOnce();
    expect(session.messages).toEqual(history().messages);
    expect(session.recovery.resuming).toBe(false);
    expect(session.streaming).toBe(false);
    expect(chatPosts()).toHaveLength(0);
  });

  it('retains a saved terminal error row and displays only the generic recovery notice', async () => {
    const saved = history(messages('Saved partial response', 'error'));
    saved.messages[1]!.metadata = { status: 'error', error: 'Secret upstream traceback' };
    network.mockResolvedValue(new Response(null, { status: 204 }));
    getHistory.mockResolvedValue(saved);
    await mount(initialPending());
    expect(session.messages).toEqual(saved.messages);
    expect(session.recovery.error).toBe(
      'The saved response ended with an error. You can retry the message.',
    );
    expect(session.recovery.error).not.toContain('Secret');
    expect(session.error).toBeUndefined();
    expect(session.streaming).toBe(false);
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledOnce();
    expect(chatPosts()).toHaveLength(0);
  });

  it('rejects mismatched and malformed canonical history before mutating SDK messages', async () => {
    const sdk = makeSdk(messages('Keep this known-good content'));
    const scope = { active: true, request: 0 };
    await settle(() =>
      root.render(<CoreHarness sdk={sdk} scope={scope} initialMessages={sdk.messages} />),
    );
    const baseline = sdk.messages;
    const malformed = [
      history(messages('Wrong conversation'), 'someone-else'),
      { ...history(), messages: null },
      { ...history(), messages: [{ id: 'bad', role: 'assistant', parts: [null] }] },
      { ...history(), thread: { id: 'thread', temporary: 'not-a-boolean' } },
    ];
    for (const snapshot of malformed) {
      getHistory.mockResolvedValueOnce(snapshot);
      await settle(() => core.recovery.recover());
      expect(sdk.messages).toBe(baseline);
      expect(core.recovery.error).toBe(
        'Could not refresh saved messages. Retry to check the response.',
      );
      expect(core.recovery.unavailable).toBe(false);
      expect(core.recovery.refreshing).toBe(false);
    }
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledTimes(malformed.length);
    expect(network).not.toHaveBeenCalled();
  });
});
