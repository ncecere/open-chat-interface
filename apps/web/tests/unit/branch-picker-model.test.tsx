// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { preloadMarkdownRenderer } from '../../src/components/chat/markdown';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * Edit → Save & submit, and a fork at a question, after switching model
 * (#275, a regression of #213). The person switches the picker away from the
 * model the question was sent with; the new conversation was answered by the
 * question's model and its picker switched back. It is answered with the
 * model shown in the picker, as Retry is. The real conversation page, chat
 * session, AI SDK, query cache, branch and fork requests run against a stubbed
 * network; only the catalog, the account and the message rendering are
 * stand-ins.
 */
const model = (slug: string, isDefault = false) =>
  ({
    slug,
    name: slug,
    isDefault,
    reasoningMode: 'none',
    supportedEfforts: [],
    capabilities: [],
  }) as unknown as CatalogModel;
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  composer: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: () => null,
}));
vi.mock('../../src/hooks/use-models', () => ({
  useModels: () => ({ data: [model('alpha', true), model('gpt-4-1-mini')], isPending: false }),
}));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { features: { branching: true }, chat: {} } }),
}));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: unknown) => {
    mocks.composer(props);
    return null;
  },
}));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));
vi.mock('../../src/components/chat/message-list', () => ({
  MessageList: (props: unknown) => {
    mocks.list(props);
    return null;
  },
}));

interface ComposerProps {
  selectedModel: CatalogModel | null;
  models: CatalogModel[];
  onSelectModel: (model: CatalogModel) => void;
}
interface ListProps {
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
}
const composer = () => mocks.composer.mock.lastCall?.[0] as ComposerProps;
const list = () => mocks.list.mock.lastCall?.[0] as ListProps;

const question: UIMessage = {
  id: 'question',
  role: 'user',
  metadata: { modelSlug: 'alpha' },
  parts: [{ type: 'text', text: 'Walk5 fail: say hello.' }],
};
const failed: UIMessage = {
  id: 'reply',
  role: 'assistant',
  metadata: { modelSlug: 'alpha' },
  parts: [{ type: 'text', text: '' }],
};
const copy: UIMessage = {
  id: 'question-copy',
  role: 'user',
  metadata: { modelSlug: 'alpha' },
  parts: [{ type: 'text', text: 'Walk5 fail edit: say hello in French.' }],
};
const histories: Record<string, UIMessage[]> = { source: [question, failed], branch: [copy] };
let chatBodies: { modelSlug?: string; threadId?: string; trigger?: string }[];
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const sse = (chunks: object[]) =>
  new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat('data: [DONE]\n\n')
      .join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-OCI-Chat-Run-Id': 'answer',
      },
    },
  );

// A conversation with replies opens once the Markdown renderer is ready (#311).
beforeAll(() => preloadMarkdownRenderer().then(() => undefined), 30_000);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  sessionStorage.clear();
  mocks.navigate.mockReset();
  mocks.composer.mockReset();
  mocks.list.mockReset();
  chatBodies = [];
  const branchedMessage = { id: 'question-copy', modelSlug: 'alpha', effort: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const method = init?.method?.toUpperCase() ?? 'GET';
      const history = /^\/api\/chat\/([^/]+)\/messages$/.exec(path)?.[1];
      if (history && histories[history])
        return Response.json({
          thread: { id: history, temporary: false, expiresAt: null, projectId: null },
          messages: histories[history],
          replies: [],
          page: { olderCursor: null, newerCursor: null, total: histories[history].length },
        });
      if (path === '/api/threads/source/branches' && method === 'POST')
        return Response.json({ thread: { id: 'branch' }, message: branchedMessage });
      if (path === '/api/threads/source/forks' && method === 'POST')
        return Response.json({
          thread: { id: 'branch' },
          message: { ...branchedMessage, role: 'user' },
        });
      if (path === '/api/chat' && method === 'POST') {
        chatBodies.push(JSON.parse(String(init?.body)));
        return sse([
          { type: 'start', messageId: 'answer' },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Bonjour.' },
          { type: 'text-end', id: 't' },
          { type: 'finish' },
        ]);
      }
      if (path.startsWith('/api/threads') && method === 'GET')
        return Response.json({ threads: [], nextCursor: null });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(threadId: string) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TemporaryChatProvider>
          <ChatThreadPage key={threadId} threadId={threadId} />
        </TemporaryChatProvider>
      </QueryClientProvider>,
    ),
  );
  // The history loads, then the conversation's session starts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens the failed conversation and switches the picker away from its model. */
async function switchModel() {
  await open('source');
  expect(composer().selectedModel?.slug).toBe('alpha');
  const next = composer().models.find((entry) => entry.slug === 'gpt-4-1-mini');
  await act(async () => composer().onSelectModel(next!));
  expect(composer().selectedModel?.slug).toBe('gpt-4-1-mini');
}

async function expectAnsweredWithPicker() {
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/chat/$threadId',
    params: { threadId: 'branch' },
  });
  await open('branch');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Answered once, by the model the person chose, and the picker still shows it.
  expect(chatBodies).toHaveLength(1);
  expect(chatBodies[0]).toMatchObject({
    threadId: 'branch',
    modelSlug: 'gpt-4-1-mini',
    trigger: 'regenerate-message',
  });
  expect(composer().selectedModel?.slug).toBe('gpt-4-1-mini');
}

it('answers an edit with the model chosen in the picker, not the question’s', async () => {
  await switchModel();
  await act(async () => list().onEdit!('question', 'Walk5 fail edit: say hello in French.'));
  await expectAnsweredWithPicker();
});

it('answers a fork made at a question with the model chosen in the picker', async () => {
  await switchModel();
  await act(async () => list().onFork!('question'));
  await expectAnsweredWithPicker();
});

it('keeps the question’s model when nothing was switched', async () => {
  await open('source');
  await act(async () => list().onEdit!('question', 'Walk5 fail edit: say hello in French.'));
  await open('branch');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(chatBodies).toHaveLength(1);
  expect(chatBodies[0]).toMatchObject({ threadId: 'branch', modelSlug: 'alpha' });
  expect(composer().selectedModel?.slug).toBe('alpha');
});
