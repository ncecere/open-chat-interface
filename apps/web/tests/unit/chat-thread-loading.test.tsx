// @vitest-environment happy-dom
import type { Attachment } from '@oci/shared';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { ChatThreadPage } from '../../src/routes/chat/thread';

interface ThreadData {
  thread: { id: string; temporary: boolean; expiresAt: string | null };
  messages: UIMessage[];
}
interface QueryState {
  data: ThreadData | undefined;
  error: unknown;
  isLoading: boolean;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  status: 'pending' | 'error' | 'success';
}

const mocks = vi.hoisted(() => ({
  query: {} as QueryState,
  useQuery: vi.fn(),
  refetch: vi.fn(),
  navigate: vi.fn(),
  back: vi.fn(),
  setTemporary: vi.fn(),
  useTemporaryChat: vi.fn(),
  useChatSession: vi.fn(),
  composer: vi.fn(),
  messageList: vi.fn(),
  send: vi.fn(),
  regenerate: vi.fn(),
  branch: vi.fn(),
  fork: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    mocks.useQuery(options);
    // Never execute queryFn: this suite tests the route's query-state boundary.
    return { ...mocks.query, refetch: mocks.refetch };
  },
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: mocks.back } }),
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
        mocks.navigate({ to });
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => {
    mocks.useTemporaryChat();
    return { temporary: false, setTemporary: mocks.setTemporary };
  },
}));
vi.mock('../../src/hooks/use-chat-session', () => ({ useChatSession: mocks.useChatSession }));
vi.mock('../../src/hooks/use-threads', () => ({
  useBranchMessage: () => ({ mutateAsync: mocks.branch }),
  useForkMessage: () => ({ mutateAsync: mocks.fork }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: unknown) => {
    mocks.composer(props);
    return <textarea aria-label="Message composer" />;
  },
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: (props: unknown) => {
    mocks.messageList(props);
    return <div data-testid="message-list" />;
  },
}));

const threadId = 'thread-loading-test';
const upload: Attachment = {
  id: 'upload-1',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 12,
  url: '/api/attachments/upload-1',
  thumbnailUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const pending = {
  'oci.pendingThreadId': threadId,
  'oci.pendingPrompt': 'Keep this unsent draft',
  'oci.pendingAttachments': JSON.stringify([upload]),
  'oci.pendingEffort': 'high',
  'oci.pendingWebSearch': 'true',
};
let container: HTMLDivElement;
let root: Root;

function setQuery(status: QueryState['status'], error: unknown = null, data?: ThreadData) {
  mocks.query = {
    data,
    error,
    status,
    isLoading: status === 'pending',
    isPending: status === 'pending',
    isFetching: status === 'pending',
    isError: status === 'error',
    isSuccess: status === 'success',
  };
}
function emptyThread(): ThreadData {
  return { thread: { id: threadId, temporary: false, expiresAt: null }, messages: [] };
}
function seedPending() {
  for (const [key, value] of Object.entries(pending)) sessionStorage.setItem(key, value);
}
function expectPendingPreserved() {
  for (const [key, value] of Object.entries(pending)) {
    expect(sessionStorage.getItem(key), key).toBe(value);
  }
}
function expectNoConversation() {
  expect(mocks.useChatSession).not.toHaveBeenCalled();
  expect(mocks.composer).not.toHaveBeenCalled();
  expect(mocks.messageList).not.toHaveBeenCalled();
  expect(container.querySelector('textarea')).toBeNull();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.regenerate).not.toHaveBeenCalled();
}
function expectNoSpinner() {
  expect(container.querySelector('[role="status"]')).toBeNull();
  // Also catches the current, inaccessible spinner (which has no status role).
  expect(container.querySelector('.animate-spin')).toBeNull();
}
function expectLoading() {
  const status = container.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(`${status?.getAttribute('aria-label') ?? ''} ${status?.textContent ?? ''}`).toContain(
    'Loading conversation',
  );
}
function control(name: RegExp, selector = 'button, a'): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((candidate) =>
    name.test(candidate.getAttribute('aria-label') ?? candidate.textContent?.trim() ?? ''),
  );
  expect(element, `Expected a control named ${name}`).toBeDefined();
  return element!;
}
async function render() {
  await act(() => root.render(<ChatThreadPage threadId={threadId} />));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  setQuery('pending');
  mocks.refetch.mockReset();
  mocks.refetch.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(() => {
    throw new Error('Unexpected network request in loader test');
  });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  mocks.useChatSession.mockImplementation(
    ({
      initialMessages,
      carriedAttachments,
    }: {
      initialMessages: UIMessage[];
      carriedAttachments: Attachment[];
    }) => ({
      messages: initialMessages,
      draft: '',
      setDraft: vi.fn(),
      streaming: false,
      status: 'ready',
      recovery: {
        resuming: false,
        remotePending: false,
        refreshing: false,
        unavailable: false,
        error: null,
        recover: vi.fn(),
        waitForServer: vi.fn(),
      },
      error: undefined,
      models: [],
      // No selected model: mounting a successful fixture must not auto-send its pending prompt.
      selectedModel: undefined,
      selectModel: vi.fn(),
      effort: 'instant',
      setEffort: vi.fn(),
      webSearch: false,
      setWebSearch: vi.fn(),
      features: {},
      attachments: { items: carriedAttachments, upload: vi.fn(), remove: vi.fn() },
      send: mocks.send,
      stop: vi.fn(),
      regenerate: mocks.regenerate,
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.branch).not.toHaveBeenCalled();
  expect(mocks.fork).not.toHaveBeenCalled();
});

describe('ChatThreadPage loading boundary', () => {
  it('announces loading without mounting chat or consuming the pending handover', async () => {
    seedPending();
    await render();
    expectNoConversation();
    expectPendingPreserved();
    expect(mocks.useTemporaryChat).toHaveBeenCalled();
    expect(mocks.setTemporary).not.toHaveBeenCalled();
    expect(mocks.refetch).not.toHaveBeenCalled();
    expectLoading();
  });

  it.each([404, 403, 401])(
    'renders unavailable navigation for HTTP %s, not an endless spinner',
    async (status) => {
      seedPending();
      setQuery(
        'error',
        new ApiError(status, status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', 'Private API detail'),
      );
      await render();
      expectNoConversation();
      expectPendingPreserved();
      expect(mocks.setTemporary).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Conversation unavailable');
      expect(container.textContent).not.toContain('Private API detail');
      expectNoSpinner();
      const navigation = control(/back|new chat/i);
      await act(() => navigation.click());
      const returnedHome = mocks.navigate.mock.calls.some(([options]) => options?.to === '/');
      expect(returnedHome || mocks.back.mock.calls.length > 0).toBe(true);
      expect(mocks.refetch).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['transient API error', new ApiError(503, 'UNAVAILABLE', 'Service temporarily unavailable')],
    [
      'unknown network error',
      new TypeError('Internal transport exception: private upstream address'),
    ],
  ])('offers an explicit query retry for a %s without sending a message', async (_name, error) => {
    seedPending();
    setQuery('error', error);
    await render();
    expectNoConversation();
    expectPendingPreserved();
    expect(container.textContent).toContain('Could not load conversation');
    if (!(error instanceof ApiError)) expect(container.textContent).not.toContain(error.message);
    expectNoSpinner();
    expect(mocks.refetch).not.toHaveBeenCalled();
    await act(() => control(/^Retry$/, 'button').click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expectNoConversation();
    expectPendingPreserved();
  });

  it('does not mount stale conversation data when the query also reports a load error', async () => {
    seedPending();
    const stale = emptyThread();
    stale.messages = [
      { id: 'stale', role: 'assistant', parts: [{ type: 'text', text: 'Stale content' }] },
    ];
    setQuery('error', new ApiError(503, 'UNAVAILABLE', 'Try later'), stale);
    await render();
    expectNoConversation();
    expectPendingPreserved();
    expect(mocks.setTemporary).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Could not load conversation');
    expectNoSpinner();
    expect(control(/^Retry$/, 'button')).toBeDefined();
  });

  it('mounts the composer for a successfully loaded empty conversation', async () => {
    setQuery('success', null, emptyThread());
    await render();
    expect(mocks.useChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, initialMessages: [] }),
    );
    expect(container.querySelector('textarea[aria-label="Message composer"]')).not.toBeNull();
    expect(mocks.composer).toHaveBeenCalled();
    expect(mocks.messageList).toHaveBeenCalled();
    expect(mocks.setTemporary).toHaveBeenCalledWith(false);
    expect(container.textContent).not.toContain('Conversation unavailable');
    expect(container.textContent).not.toContain('Could not load conversation');
    expectNoSpinner();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it.each(['another-thread', 'unscoped'])(
    'does not auto-send or import a %s handover',
    async (owner) => {
      seedPending();
      if (owner === 'unscoped') sessionStorage.removeItem('oci.pendingThreadId');
      else sessionStorage.setItem('oci.pendingThreadId', owner);
      const base = mocks.useChatSession.getMockImplementation()!;
      mocks.useChatSession.mockImplementation((options) => ({
        ...base(options),
        selectedModel: { slug: 'model' },
      }));
      setQuery('success', null, emptyThread());
      await render();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('oci.pendingPrompt')).toBe(pending['oci.pendingPrompt']);
      expect(mocks.useChatSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          carriedAttachments: [],
          initialEffort: undefined,
          initialWebSearch: false,
        }),
      );
    },
  );

  it('consumes a matching handover only once, after a successful load', async () => {
    seedPending();
    const base = mocks.useChatSession.getMockImplementation()!;
    mocks.useChatSession.mockImplementation((options) => ({
      ...base(options),
      selectedModel: { slug: 'model' },
    }));
    setQuery('success', null, emptyThread());
    await render();
    await render();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(pending['oci.pendingPrompt']);
    for (const key of Object.keys(pending)) expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('does not carry a previous thread’s consumed upload handover into another thread', async () => {
    seedPending();
    setQuery('success', null, emptyThread());
    await render();
    expect(mocks.useChatSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ carriedAttachments: [upload] }),
    );
    sessionStorage.clear(); // The first conversation consumed its handover.
    setQuery('success', null, {
      thread: { id: 'other', temporary: false, expiresAt: null },
      messages: [],
    });
    await act(() => root.render(<ChatThreadPage threadId="other" />));
    expect(mocks.useChatSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: 'other', carriedAttachments: [] }),
    );
  });

  it('preserves draft and uploads through failure and retry, mounting chat only after success', async () => {
    seedPending();
    setQuery('error', new TypeError('Failed to fetch'));
    mocks.refetch.mockImplementation(async () => {
      setQuery('pending');
    });
    await render();
    expectNoConversation();
    expectPendingPreserved();
    await act(() => control(/^Retry$/, 'button').click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    await render();
    expectNoConversation();
    expectPendingPreserved();
    expectLoading();

    setQuery('success', null, emptyThread());
    await render();
    expect(mocks.useChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        initialMessages: [],
        carriedAttachments: [upload],
        initialEffort: 'high',
        initialWebSearch: true,
      }),
    );
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(mocks.composer).toHaveBeenCalledWith(expect.objectContaining({ attachments: [upload] }));
    expectPendingPreserved();
    expectNoSpinner();
    expect(container.textContent).not.toContain('Could not load conversation');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });
});
