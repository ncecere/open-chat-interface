// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';
import { advance, settle } from './chat-recovery.fixtures';

// Stop pressed while the server cannot take it (#351): a database outage made
// the stop request answer a retryable 500, or fail outright, and the page
// swallowed it and kept saying "Stopping the reply…" while the reply ran to
// its end. The chat session, the AI SDK, the recovery checks and the query
// cache are real; only the server behind `fetch` is simulated: it fails the
// stop request (a 500 with the retryable header, or a refused connection),
// then takes it, after which the reply is saved as stopped.
const { models } = vi.hoisted(() => ({
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
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));

const pending: UIMessage[] = [
  { id: 'run', role: 'assistant', parts: [], metadata: { status: 'streaming' } },
];
const stopped: UIMessage[] = [
  { id: 'run', role: 'assistant', parts: [], metadata: { status: 'cancelled' } },
];
const partial = [
  { type: 'start', messageId: 'run' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'Answer' },
];

let root: Root;
let session: ReturnType<typeof useChatSession>;
let queryClient: QueryClient;
/** Answers of the stop request, in order; the last one repeats. */
let stopAnswers: Array<'fail-500' | 'fail-network' | 'ok' | 'forbidden'>;
let stopped_: boolean;
let network: ReturnType<typeof vi.fn<typeof fetch>>;

function Harness() {
  session = useChatSession({ threadId: 'thread', initialMessages: pending });
  return null;
}
const deletes = () => network.mock.calls.filter(([, init]) => init?.method === 'DELETE');

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stopped_ = false;
  queryClient = new QueryClient();
  network = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') {
      const answer = stopAnswers[Math.min(deletes().length - 1, stopAnswers.length - 1)];
      if (answer === 'fail-network') throw new TypeError('Failed to fetch');
      if (answer === 'fail-500')
        return Response.json(
          { error: { code: 'INTERNAL_ERROR', message: 'interrupted', retryable: true } },
          { status: 500, headers: { 'X-OCI-Retryable': 'database-connection' } },
        );
      if (answer === 'forbidden') return Response.json({ error: {} }, { status: 403 });
      stopped_ = true;
      return Response.json({ cancelled: true });
    }
    if (new URL(String(url), 'http://local').pathname.endsWith('/messages'))
      return Response.json({
        thread: { id: 'thread', temporary: false, expiresAt: null },
        messages: stopped_ ? stopped : pending,
        replies: [],
      });
    // The replay reader the page has open: some text, then nothing more.
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of partial)
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Stopped', 'AbortError')),
            { once: true },
          );
        },
      }),
      { headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': 'run' } },
    );
  });
  vi.stubGlobal('fetch', network);
  root = createRoot(document.createElement('div'));
  await settle(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  expect(session.status).toBe('streaming');
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe('Stop while the server cannot take it (#351)', () => {
  it.each([
    ['a retryable 500', 'fail-500'],
    ['a refused connection', 'fail-network'],
  ] as const)(
    'sends it again after %s, says so, and ends once the reply is stopped',
    async (_name, failure) => {
      stopAnswers = [failure, failure, 'ok'];
      await act(() => session.stop());
      expect(deletes()).toHaveLength(1);
      // Before: nothing more was sent and the page said "Stopping the reply…" for good.
      await settle();
      expect(session.stopDelayed).toBe(true);
      expect(session.recovery.stopping).toBe(true);
      // Stop stays a real control: the composer shows it while this is true.
      expect(session.streaming).toBe(true);

      await advance(1_000);
      expect(deletes()).toHaveLength(2);
      expect(session.stopDelayed).toBe(true);

      // Still failing: the pause grows, and the page still says it is trying.
      await advance(1_999);
      expect(deletes()).toHaveLength(2);
      await advance(1);
      expect(deletes()).toHaveLength(3);

      // Taken: the reply is saved as stopped and nothing is pending or stopping.
      await advance(1_000);
      expect(session.stopDelayed).toBe(false);
      expect(session.recovery.stopping).toBe(false);
      expect(session.recovery.remotePending).toBe(false);
      expect(session.messages.at(-1)?.metadata).toEqual({ status: 'cancelled' });
      expect(session.streaming).toBe(false);
      await advance(60_000);
      expect(deletes()).toHaveLength(3);
    },
  );

  it('stops asking once the reply has been saved as stopped some other way', async () => {
    stopAnswers = ['fail-500'];
    await act(() => session.stop());
    await advance(1_000);
    expect(deletes()).toHaveLength(2);
    // Stopped from another tab: the next check finds it saved as stopped.
    stopped_ = true;
    await advance(20_000);
    expect(session.recovery.stopping).toBe(false);
    expect(session.stopDelayed).toBe(false);
    const sent = deletes().length;
    await advance(60_000);
    expect(deletes()).toHaveLength(sent);
  });

  it('does not keep asking when the server refuses for good', async () => {
    stopAnswers = ['forbidden'];
    await act(() => session.stop());
    await advance(60_000);
    expect(deletes()).toHaveLength(1);
    expect(session.stopDelayed).toBe(false);
  });

  it('asks at once when Stop is pressed again, without waiting out the pause', async () => {
    stopAnswers = ['fail-500', 'fail-500', 'ok'];
    await act(() => session.stop());
    await advance(1_000);
    expect(deletes()).toHaveLength(2);
    await act(() => session.stop());
    expect(deletes()).toHaveLength(3);
    await advance(0);
    expect(session.stopDelayed).toBe(false);
    await advance(2_000);
    expect(session.recovery.remotePending).toBe(false);
    // Not two requests going on at once after the second press.
    await advance(60_000);
    expect(deletes()).toHaveLength(3);
  });
});
