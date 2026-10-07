// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistory } from '../../src/lib/chat-history';
import {
  advance,
  deferred,
  history,
  initialPending,
  messages,
  type RecoveryCore,
  type RecoverySession,
  recoveryHarness,
  settle,
  sse,
} from './chat-recovery.fixtures';

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

let root: Root;
let session: RecoverySession;
let core: RecoveryCore;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let clearRun: ReturnType<typeof vi.fn<(id: string) => void>>;
const { SessionHarness, CoreHarness, makeSdk, mount, chatPosts } = recoveryHarness({
  root: () => root,
  network: () => network,
  clearRun: () => clearRun,
  onSession: (next) => {
    session = next;
  },
  onCore: (next) => {
    core = next;
  },
});

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
    // The latest page, sized to reach past the live messages (v0.11).
    expect(getHistory).toHaveBeenCalledExactlyOnceWith('/chat/thread/messages?limit=100', {
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

  it.each(['finish', 'friendly-error'] as const)(
    'awaits the entire resume through %s before hydrating saved messages',
    async (ending) => {
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
      await settle(() => session.setDraft('Keep my next question'));
      await advance(6_000);
      expect(getHistory).not.toHaveBeenCalled();

      await settle(() => {
        if (ending === 'finish') {
          replay.push({ type: 'text-end', id: 'text-1' });
          replay.push({ type: 'finish', finishReason: 'stop' });
        } else {
          replay.push({
            type: 'error',
            errorText:
              'Live replay is no longer available. Reload this conversation to see saved messages; a response may still be running.',
          });
        }
        replay.close();
      });
      expect(getHistory).toHaveBeenCalledOnce();
      expect(session.messages).toEqual(saved.messages);
      expect(session.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect(session.streaming).toBe(false);
      expect(session.draft).toBe('Keep my next question');
      expect(session.error).toBeUndefined();
      await advance(4_000);
      expect(getHistory).toHaveBeenCalledOnce();
      expect(chatPosts()).toHaveLength(0);
    },
  );

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
});
