// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCommandPaletteState } from '../../src/components/command-palette/use-command-palette-state';

/**
 * "New chat with query" in the command palette (v0.10.2): one conversation
 * per choice however often Enter arrives, and the query is handed to that
 * conversation the way the home page hands over its prompt, so it is sent
 * rather than left behind with an empty "New Chat".
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  state: undefined as ReturnType<typeof useCommandPaletteState> | undefined,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../src/hooks/use-threads', () => ({
  useCreateThread: () => ({ mutateAsync: mocks.create, isPending: false }),
}));
vi.mock('../../src/hooks/use-thread-search', () => ({
  SEARCH_DEBOUNCE_MS: 0,
  useThreadSearch: () => ({
    data: [],
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
  }),
  searchResultTarget: vi.fn(),
  searchResultsAnnouncement: () => '',
}));
vi.mock('../../src/components/command-palette/use-palette-actions', () => ({
  usePaletteActions: () => [],
}));
vi.mock('../../src/components/layout/thread-search-results', () => ({
  SearchResultContent: () => null,
}));

function Harness() {
  mocks.state = useCommandPaletteState({
    open: true,
    onOpenChange: vi.fn(),
    sidebarOpen: true,
    onSidebarOpenChange: vi.fn(),
  });
  return null;
}

let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.navigate.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div'));
  await act(() => root.render(<Harness />));
  await act(() => mocks.state!.setQuery('Plan a picnic'));
});
afterEach(async () => {
  await act(() => root.unmount());
});

function newChatItem() {
  const item = mocks.state!.items.find((candidate) => candidate.id === 'new-chat-with-query');
  expect(item).toBeDefined();
  return item!;
}

it('starts one conversation however often it is chosen while starting', async () => {
  let finish!: (value: { thread: { id: string } }) => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const item = newChatItem();
  const first = item.onSelect();
  for (let press = 0; press < 20; press += 1) await item.onSelect();
  expect(mocks.create).toHaveBeenCalledOnce();

  await act(async () => {
    finish({ thread: { id: 'fresh' } });
    await first;
  });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    to: '/chat/$threadId',
    params: { threadId: 'fresh' },
  });
});

it('addresses the query to the new conversation and drops a stale handover', async () => {
  sessionStorage.setItem('oci.pendingThreadId', 'earlier');
  sessionStorage.setItem('oci.pendingModel', 'old-model');
  sessionStorage.setItem('oci.pendingAttachments', '[]');
  mocks.create.mockResolvedValueOnce({ thread: { id: 'fresh' } });
  mocks.navigate.mockImplementationOnce(async () => {
    expect(sessionStorage.getItem('oci.pendingThreadId')).toBe('fresh');
    expect(sessionStorage.getItem('oci.pendingPrompt')).toBe('Plan a picnic');
    expect(sessionStorage.getItem('oci.pendingModel')).toBeNull();
    expect(sessionStorage.getItem('oci.pendingAttachments')).toBeNull();
  });
  await act(() => newChatItem().onSelect());
  expect(mocks.navigate).toHaveBeenCalledOnce();
});

it('can be chosen again after a failure', async () => {
  mocks.create.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(newChatItem().onSelect()).rejects.toThrow('Unavailable');
  mocks.create.mockResolvedValueOnce({ thread: { id: 'fresh' } });
  await act(() => newChatItem().onSelect());
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
