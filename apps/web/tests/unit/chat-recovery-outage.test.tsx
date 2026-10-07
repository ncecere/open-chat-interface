// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_RETRYING_TEXT } from '../../src/hooks/use-chat-recovery';
import {
  advance,
  initialPending,
  messages,
  type RecoveryCore,
  type RecoverySession,
  recoveryHarness,
} from './chat-recovery.fixtures';

// The API client, history validation, AI SDK, recovery and session are all
// real; only the server behind `fetch` is simulated: crashed (the connection
// is refused), then answering 502 from the proxy while it starts, then back
// with the reply recovery saved as interrupted (#229).
const { invalidateQueries, models } = vi.hoisted(() => ({
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
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));

type ServerState = 'down' | 'starting' | 'up';
let server: ServerState;
const interrupted = messages(
  'Partial answer\u2026 This reply was interrupted because the server writing it stopped.',
  'cancelled',
);
let root: Root;
let session: RecoverySession;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
const { mount, chatPosts } = recoveryHarness({
  root: () => root,
  network: () => network,
  clearRun: () => vi.fn(),
  onSession: (next) => {
    session = next;
  },
  onCore: (_: RecoveryCore) => undefined,
});
const historyCalls = () =>
  network.mock.calls.filter(([input]) => String(input).startsWith('/api/chat/thread/messages'));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  server = 'down';
  network = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    // The browser's own error for a refused connection.
    if (server === 'down') throw new TypeError('Failed to fetch');
    if (server === 'starting')
      return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
    if (url === '/api/chat/thread/stream') return new Response(null, { status: 204 });
    if (url.startsWith('/api/chat/thread/messages'))
      return Response.json({
        thread: { id: 'thread', temporary: false, expiresAt: null },
        messages: interrupted,
        replies: [],
      });
    throw new Error(`Unexpected network request: ${url}`);
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

describe('chat recovery while the API is down (#229)', () => {
  it('keeps checking through failed checks and shows the saved reply once the server is back', async () => {
    // The page opens (or the stream breaks) with a reply pending while the
    // API has crashed: the reconnect and the first check both fail.
    await mount(initialPending());
    expect(historyCalls()).toHaveLength(1);
    expect(session.recovery.error).toBe(RECOVERY_RETRYING_TEXT);
    expect(session.recovery.remotePending).toBe(true);

    // Still down for the next check; then the proxy answers 502 while the
    // API starts.
    await advance(4_000);
    expect(historyCalls()).toHaveLength(2);
    server = 'starting';
    await advance(8_000);
    expect(historyCalls()).toHaveLength(3);
    expect(session.recovery.remotePending).toBe(true);
    expect(session.recovery.error).toBe(RECOVERY_RETRYING_TEXT);

    // The server is back and recovery has saved the reply: the next check,
    // at most 15 s later, shows it and ends the pending state.
    server = 'up';
    await advance(15_000);
    expect(historyCalls()).toHaveLength(4);
    expect(session.messages).toEqual(interrupted);
    expect(session.recovery.remotePending).toBe(false);
    expect(session.recovery.error).toBeNull();
    expect(session.streaming).toBe(false);

    // Nothing pending any more: no further checks, and nothing was resent.
    await advance(60_000);
    expect(historyCalls()).toHaveLength(4);
    expect(chatPosts()).toHaveLength(0);
  });

  it('never waits more than 15 s between checks during a long outage', async () => {
    await mount(initialPending());
    await advance(4_000 + 8_000 + 15_000 + 15_000);
    expect(historyCalls()).toHaveLength(5);
    server = 'up';
    await advance(15_000);
    expect(session.recovery.remotePending).toBe(false);
    expect(session.messages).toEqual(interrupted);
  });
});
