// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_FAILED_TEXT, RECOVERY_RETRYING_TEXT } from '../../src/hooks/use-chat-recovery';
import { ApiError } from '../../src/lib/api-client';
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
  it('keeps checking, less often, after transient failures; explicit Retry preserves draft and an in-flight upload', async () => {
    const upload = deferred<Response>();
    network.mockImplementation(async (input) => {
      if (String(input) === '/api/attachments') return upload.promise;
      return new Response(null, { status: 204 });
    });
    getHistory.mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'Internal upstream details'));
    await mount(initialPending());
    expect(session.recovery.error).toBe(RECOVERY_RETRYING_TEXT);
    expect(session.recovery.unavailable).toBe(false);
    expect(session.recovery.remotePending).toBe(true);
    // Backoff after each failure: 4 s, then 8 s (#229).
    await advance(3_999);
    expect(getHistory).toHaveBeenCalledOnce();
    await advance(1);
    expect(getHistory).toHaveBeenCalledTimes(2);
    await advance(7_999);
    expect(getHistory).toHaveBeenCalledTimes(2);
    getHistory.mockReset();
    getHistory.mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'Internal upstream details'));

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
    expect(getHistory).toHaveBeenCalledOnce();
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
      expect(core.recovery.error).toBe(RECOVERY_FAILED_TEXT);
      expect(core.recovery.unavailable).toBe(false);
      expect(core.recovery.refreshing).toBe(false);
    }
    await advance(10_000);
    expect(getHistory).toHaveBeenCalledTimes(malformed.length);
    expect(network).not.toHaveBeenCalled();
  });
});
