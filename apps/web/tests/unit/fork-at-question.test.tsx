// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * Forking at your own question (#213), through the real conversation page:
 * the fork held only the question, with no reply and no Retry. It is now
 * answered when it opens, as an edit is. The fork request, the chat session
 * and the message list are stand-ins; the page's own decisions are not.
 */
const mocks = vi.hoisted(() => ({
  data: null as unknown,
  navigate: vi.fn(),
  regenerate: vi.fn(),
  fork: vi.fn(),
  onFork: undefined as undefined | ((messageId: string) => Promise<void>),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: mocks.data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    fetchStatus: 'idle',
    status: 'success',
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: () => null,
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
}));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/hooks/use-threads', () => ({
  useBranchMessage: () => ({ mutateAsync: vi.fn() }),
  useForkMessage: () => ({ mutateAsync: mocks.fork }),
}));
vi.mock('../../src/components/chat/composer', () => ({ Composer: () => null }));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: (props: { onFork?: (messageId: string) => Promise<void> }) => {
    mocks.onFork = props.onFork;
    return null;
  },
}));
vi.mock('../../src/hooks/use-chat-session', () => ({
  useChatSession: ({ initialMessages }: { initialMessages: UIMessage[] }) => ({
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
    models: [{ slug: 'gpt-4-1-mini' }],
    selectedModel: { slug: 'gpt-4-1-mini' },
    selectModel: vi.fn(),
    effort: 'instant',
    setEffort: vi.fn(),
    webSearch: false,
    setWebSearch: vi.fn(),
    features: { branching: true },
    attachments: { items: [], upload: vi.fn(), remove: vi.fn() },
    send: vi.fn(),
    stop: vi.fn(),
    regenerate: mocks.regenerate,
    setMessages: vi.fn(),
  }),
}));

const question: UIMessage = {
  id: 'question',
  role: 'user',
  parts: [{ type: 'text', text: 'Walk3 edit: list three facts about owls.' }],
};
const reply: UIMessage = {
  id: 'reply',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Owls fly silently.' }],
};
const conversation = (id: string, messages: UIMessage[]) => ({
  thread: { id, temporary: false, expiresAt: null, projectId: null },
  messages,
  replies: [],
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function open(threadId: string, messages: UIMessage[]) {
  mocks.data = conversation(threadId, messages);
  await act(() => root.render(<ChatThreadPage key={threadId} threadId={threadId} />));
}

it('answers a fork made at a question once it opens', async () => {
  await open('source', [question, reply]);
  mocks.fork.mockResolvedValue({
    thread: { id: 'fork' },
    message: { id: 'question-copy', role: 'user', modelSlug: null, effort: null },
  });
  await act(() => mocks.onFork!('question'));
  expect(mocks.fork).toHaveBeenCalledWith({ threadId: 'source', messageId: 'question' });
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/chat/$threadId',
    params: { threadId: 'fork' },
  });

  // The fork holds only the question; its answer is asked for at once.
  await open('fork', [{ ...question, id: 'question-copy' }]);
  expect(mocks.regenerate).toHaveBeenCalledExactlyOnceWith({ messageId: 'question-copy' });
});

it('does not answer again in a fork made at a reply', async () => {
  await open('source', [question, reply]);
  mocks.fork.mockResolvedValue({
    thread: { id: 'fork' },
    message: { id: 'reply-copy', role: 'assistant', modelSlug: 'gpt-4-1-mini', effort: null },
  });
  await act(() => mocks.onFork!('reply'));
  await open('fork', [
    { ...question, id: 'question-copy' },
    { ...reply, id: 'reply-copy' },
  ]);
  expect(mocks.regenerate).not.toHaveBeenCalled();
});
