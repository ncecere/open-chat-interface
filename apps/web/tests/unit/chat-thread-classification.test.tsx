// @vitest-environment happy-dom
import type { ClassificationResponse } from '@oci/shared';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { preloadMarkdownRenderer } from '../../src/components/chat/markdown';
import { ApiError } from '../../src/lib/api-client';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * The conversation page with data classes (v0.14, #395): the chips under the
 * title, the model picker's and composer's view of them, and a refused send.
 */
const mocks = vi.hoisted(() => ({
  classification: undefined as ClassificationResponse | undefined,
  useChatSession: vi.fn(),
  composer: vi.fn(),
  selectModel: vi.fn(),
  keys: [] as unknown[][],
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    mocks.keys.push(options.queryKey);
    const [first, second] = options.queryKey;
    if (first === 'thread')
      return {
        data: {
          thread: { id: 'thread-1', temporary: false, expiresAt: null, projectId: null },
          messages: [] as UIMessage[],
        },
        isLoading: false,
        isError: false,
        error: null,
        fetchStatus: 'idle',
        isFetching: false,
        refetch: vi.fn(),
      };
    if (first === 'classification' && second === 'classes')
      return { data: [{ id: 'c-new', name: 'Research data' }] };
    if (first === 'classification') return { data: mocks.classification };
    return { data: undefined };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
}));
vi.mock('../../src/hooks/use-chat-session', () => ({ useChatSession: mocks.useChatSession }));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/hooks/use-threads', () => ({
  useBranchMessage: () => ({ mutateAsync: vi.fn() }),
  useForkMessage: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: unknown) => {
    mocks.composer(props);
    return <textarea aria-label="Message composer" />;
  },
}));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

const approvedModel = { slug: 'approved', displayName: 'Approved model' };
let container: HTMLDivElement;
let root: Root;

function session(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    draft: 'Marks for J. Smith',
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
    notice: null,
    refused: false,
    models: [approvedModel, { slug: 'plain', displayName: 'Plain model' }],
    selectedModel: undefined,
    selectModel: mocks.selectModel,
    effort: 'instant',
    setEffort: vi.fn(),
    webSearch: false,
    setWebSearch: vi.fn(),
    features: {},
    attachments: { items: [], upload: vi.fn(), remove: vi.fn() },
    send: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    ...overrides,
  };
}

const blocked = (point = 'send') =>
  new Error(
    JSON.stringify({
      error: {
        code: 'DATA_CLASS_BLOCKED',
        message: 'Your message was not sent. Plain model is not approved for Student records.',
        details: {
          point,
          model: { slug: 'plain', displayName: 'Plain model' },
          missing: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
          approvedModels: [approvedModel],
        },
      },
    }),
  );

beforeAll(() => preloadMarkdownRenderer().then(() => undefined), 30_000);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.keys.length = 0;
  mocks.classification = {
    mode: 'block',
    classes: [
      { id: 'c1', name: 'Student records', reasons: ['project'], removable: false },
      { id: 'c2', name: 'Health data', reasons: ['person'], removable: true },
    ],
    models: [],
  };
  mocks.useChatSession.mockImplementation(() => session());
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) => {
      throw new Error(`Unexpected network request: ${String(url)}`);
    }),
  );
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = () => act(() => root.render(<ChatThreadPage threadId="thread-1" />));
const chips = () =>
  [...container.querySelectorAll('[data-class-chip]')].map(
    (node) => node.textContent?.split('·')[0],
  );

it('asks about the conversation, and gives the answer to the session and the composer', async () => {
  await render();
  expect(mocks.keys).toContainEqual(['classification', 'thread', 'thread-1']);
  expect(mocks.useChatSession.mock.calls[0]![0].classification).toBe(mocks.classification);
  expect(mocks.composer.mock.calls[0]![0].classification).toBe(mocks.classification);
});

it('shows the chips above the messages, with Add label', async () => {
  await render();
  expect(chips()).toEqual(['Student records', 'Health data']);
  expect(container.querySelector('button[aria-label="Add label"]')).not.toBeNull();
  const list = container.querySelector('[data-testid="message-list"]')!;
  const row = container.querySelector('[data-class-chip]')!;
  expect(row.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows no chips and no controls while classification is off, or not loaded', async () => {
  mocks.classification = { mode: 'off', classes: [], models: [] };
  await render();
  expect(container.querySelector('[data-class-chip]')).toBeNull();
  expect(container.querySelector('button[aria-label="Add label"]')).toBeNull();
  await act(() => root.unmount());
  root = createRoot(container);
  mocks.classification = undefined;
  await render();
  expect(container.querySelector('[data-class-chip]')).toBeNull();
});

it('shows a refused send with the approved models as buttons, and switching uses the picker’s own path', async () => {
  mocks.useChatSession.mockImplementation(() => session({ error: blocked(), refused: true }));
  await render();
  const notice = container.querySelector('[data-classification-blocked="send"]')!;
  expect(notice.textContent).toContain(
    'Your message was not sent. Plain model is not approved for Student records.',
  );
  const use = [...notice.querySelectorAll('button')];
  expect(use.map((node) => node.textContent)).toEqual(['Use Approved model']);
  await act(() => use[0]!.click());
  expect(mocks.selectModel).toHaveBeenCalledWith(approvedModel);
  // It is the only alert: the ordinary error text is not shown beside it.
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

it('offers no model for a refusal another model cannot help', async () => {
  mocks.useChatSession.mockImplementation(() =>
    session({ error: blocked('approval'), refused: true }),
  );
  await render();
  expect(container.querySelector('[data-classification-blocked="approval"] button')).toBeNull();
});

it('shows any other error as before', async () => {
  mocks.useChatSession.mockImplementation(() =>
    session({
      error: new Error(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too fast.' } })),
      refused: true,
    }),
  );
  await render();
  expect(container.querySelector('[data-classification-blocked]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too fast.');
});

it('keeps a notice about an unsaved message ahead of the refusal', async () => {
  mocks.useChatSession.mockImplementation(() =>
    session({ error: blocked(), notice: 'Your message could not be saved.', refused: true }),
  );
  await render();
  expect(container.querySelector('[data-classification-blocked]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Your message could not be saved.',
  );
});

it('does not read an API error’s body as a refusal unless it is one', async () => {
  mocks.useChatSession.mockImplementation(() =>
    session({ error: new ApiError(403, 'FORBIDDEN', 'No.'), refused: true }),
  );
  await render();
  expect(container.querySelector('[data-classification-blocked]')).toBeNull();
});
