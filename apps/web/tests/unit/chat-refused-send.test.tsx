// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';

/**
 * A new message the server refuses before saving it (rate limit, quota, too
 * many files) keeps its text and leaves the conversation as it was.
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

const earlier: UIMessage[] = [
  { id: 'saved-user', role: 'user', parts: [{ type: 'text', text: 'Earlier question' }] },
  { id: 'saved-reply', role: 'assistant', parts: [{ type: 'text', text: 'Earlier answer' }] },
];

let root: Root;
let session: ReturnType<typeof useChatSession>;
function Harness() {
  session = useChatSession({ threadId: 'thread', initialMessages: earlier });
  return null;
}

const refused = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message } }), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after': '21' },
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('puts the text back and drops the unsaved bubble when the send is refused', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => refused(429, 'You are sending messages too quickly.')),
  );
  await act(() => root.render(<Harness />));
  await act(() => session.setDraft('Walk: a carefully written question'));
  await act(() => session.send());

  expect(session.draft).toBe('Walk: a carefully written question');
  expect(session.messages.map((message) => message.id)).toEqual(['saved-user', 'saved-reply']);
  // The reason is still shown.
  expect(session.error?.message).toContain('too quickly');
});

it('does not overwrite something typed while the refused send was in flight', async () => {
  let answer: (response: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ),
  );
  await act(() => root.render(<Harness />));
  let sending: Promise<void> = Promise.resolve();
  await act(async () => {
    sending = session.send('First attempt');
  });
  await act(() => session.setDraft('Something new'));
  await act(async () => {
    answer(refused(429, 'You are sending messages too quickly.'));
    await sending;
  });

  expect(session.draft).toBe('Something new');
});
