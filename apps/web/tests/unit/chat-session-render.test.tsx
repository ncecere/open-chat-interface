// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';

const { chat, models, queryClient, me } = vi.hoisted(() => ({
  me: { data: undefined as unknown },
  chat: {
    status: 'streaming',
    messages: [],
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
    regenerate: vi.fn(),
  },
  models: [
    {
      slug: 'first',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
    {
      slug: 'second',
      isDefault: false,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ ...chat }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => me,
}));

let root: Root;
let session: ReturnType<typeof useChatSession>;
function Harness({
  tick,
  threadId = 'thread',
  initialModelSlug,
}: {
  tick: number;
  threadId?: string;
  initialModelSlug?: string | null;
}) {
  session = useChatSession({ threadId, initialModelSlug });
  return <span>{tick}</span>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  me.data = undefined;
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('preserves composer callbacks across stream-only rerenders, not across draft changes', async () => {
  await act(() => root.render(<Harness tick={0} />));
  const first = session;
  for (let tick = 1; tick <= 20; tick++) {
    await act(() => root.render(<Harness tick={tick} />));
    expect(session.send).toBe(first.send);
    expect(session.stop).toBe(first.stop);
    expect(session.selectModel).toBe(first.selectModel);
    expect(session.attachments.items).toBe(first.attachments.items);
  }
  await act(() => session.setDraft('Latest draft'));
  expect(session.send).not.toBe(first.send);
  await act(() => session.send());
  expect(chat.sendMessage).toHaveBeenLastCalledWith(
    {
      parts: [{ type: 'text', text: 'Latest draft' }],
    },
    { body: { attachmentIds: [] } },
  );
  expect(session.draft).toBe('');
});

it('selects the latest model and targets the latest thread when stopping', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await act(() => root.render(<Harness tick={0} />));
  const selectModel = session.selectModel;
  await act(() => selectModel(models[1] as CatalogModel));
  expect(session.selectedModel?.slug).toBe('second');
  // The choice belongs to this conversation, not the browser (v0.10).
  expect(localStorage.getItem('oci.model')).toBeNull();
  await act(() => root.render(<Harness tick={1} threadId="next-thread" />));
  expect(chat.stop).toHaveBeenCalledOnce(); // Dispose the previous browser reader, not its producer.
  expect(fetch).not.toHaveBeenCalled();
  await act(() => session.stop());
  expect(chat.stop).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith('/api/chat/next-thread/stream', {
    method: 'DELETE',
    credentials: 'same-origin',
  });
});

it('starts from the conversation, then the person, then the instance default (v0.10)', async () => {
  // Nothing chosen and no personal default: the catalog default.
  await act(() => root.render(<Harness tick={0} />));
  expect(session.selectedModel?.slug).toBe('first');

  // The person's default arrives after the catalog and still applies.
  me.data = { chat: { defaultModelSlug: 'second', defaultEffort: 'instant' } };
  await act(() => root.render(<Harness tick={1} />));
  expect(session.selectedModel?.slug).toBe('second');

  // A browser value from before v0.10 is not read.
  me.data = undefined;
  localStorage.setItem('oci.model', 'second');
  await act(() => root.render(<Harness key="other" tick={2} threadId="other" />));
  expect(session.selectedModel?.slug).toBe('first');

  // An explicit choice in the conversation wins over the person's default
  // (the thread view remounts the session for each conversation)...
  me.data = { chat: { defaultModelSlug: 'first', defaultEffort: 'instant' } };
  await act(() =>
    root.render(<Harness key="third" tick={3} threadId="third" initialModelSlug="second" />),
  );
  expect(session.selectedModel?.slug).toBe('second');

  // ...and one no longer in the catalog falls through silently.
  await act(() =>
    root.render(<Harness key="fourth" tick={4} threadId="fourth" initialModelSlug="retired" />),
  );
  expect(session.selectedModel?.slug).toBe('first');
});
