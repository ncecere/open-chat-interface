// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';

const { chat, models, queryClient } = vi.hoisted(() => ({
  chat: {
    status: 'streaming',
    messages: [],
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
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
  useCurrentUser: () => ({ data: undefined }),
}));

let root: Root;
let session: ReturnType<typeof useChatSession>;
function Harness({ tick, threadId = 'thread' }: { tick: number; threadId?: string }) {
  session = useChatSession({ threadId });
  return <span>{tick}</span>;
}
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
  expect(localStorage.getItem('oci.model')).toBe('second');
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
