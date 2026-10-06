// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatThreadPage } from '../../src/routes/chat/thread';
import { compileClasses } from './css-test-utils';

/**
 * #311: on a slow connection a saved conversation showed its replies as
 * Markdown source ("### Second example", "| Name | Value |") for 1-2 s while
 * the lazily loaded renderer arrived, then jumped as code blocks and tables
 * appeared (CLS up to 0.10). The page now opens a conversation with replies
 * once the renderer is ready, and a loaded renderer draws on the first commit.
 * The real page and Markdown component; the session and list are stand-ins.
 */
const mocks = vi.hoisted(() => ({
  data: null as unknown,
  navigate: vi.fn(),
  regenerate: vi.fn(),
  fork: vi.fn(),
  firstPaint: undefined as string | undefined,
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
// The list stands in, but each reply is drawn by the real Markdown renderer.
// What its first commit holds is recorded before the browser could paint it.
vi.mock('../../src/components/chat/message-list', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  const { Markdown } = await import('../../src/components/chat/markdown');
  return {
    MessageList: ({ messages }: { messages: UIMessage[] }) => {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        mocks.firstPaint ??= ref.current?.innerHTML ?? '';
      }, []);
      return (
        <div ref={ref}>
          {messages.map((message) => (
            <Markdown key={message.id}>
              {message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
            </Markdown>
          ))}
        </div>
      );
    },
  };
});
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

const REPLY = [
  '### Second example',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '',
  '[Walk7 Documentation](https://example.com/docs)',
  '',
  '```bash',
  'python parse.py data.csv',
  '```',
].join('\n');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("shows a saved conversation's replies as formatted from the first paint", async () => {
  mocks.data = {
    thread: { id: 'saved', temporary: false, expiresAt: null, projectId: null },
    messages: [
      { id: 'q', role: 'user', parts: [{ type: 'text', text: 'Show me an example.' }] },
      { id: 'r', role: 'assistant', parts: [{ type: 'text', text: REPLY }] },
    ],
    replies: [],
  };
  await act(() => root.render(<ChatThreadPage threadId="saved" />));
  // While the renderer loads, the conversation's loading state, not its source.
  await vi.waitFor(() => expect(mocks.firstPaint).toBeDefined(), { timeout: 20_000 });
  const first = mocks.firstPaint!;
  expect(first).not.toContain('### Second example');
  expect(first).not.toContain('| Name | Value |');
  expect(first).toMatch(/<h\d[^>]*>Second example<\/h\d>/);
  expect(first).toContain('<table');

  // Streamdown lays out an off-screen code block at an assumed 200 px
  // (content-visibility: auto), so a conversation opened at its end drew each
  // block at 200 px, then at its height a frame later (#311). The reply's own
  // classes, compiled by Tailwind, lay every block out at once.
  const block = container.querySelector<HTMLElement>('[data-streamdown="code-block"]')!;
  expect(block.style.contentVisibility).toBe('auto');
  const classes = new Set<string>();
  for (let node: HTMLElement | null = block; node; node = node.parentElement)
    for (const name of node.classList) classes.add(name);
  const css = await compileClasses([...classes]);
  const applied = [...css.matchAll(/^([^{}@\n][^{}]*)\{([^{}]*)\}/gm)]
    .filter(([, selector]) => {
      try {
        return block.matches(selector!.trim());
      } catch {
        return false; // A selector happy-dom cannot parse (none of them is this rule).
      }
    })
    .flatMap(([, , body]) => body!.split(';').map((declaration) => declaration.trim()))
    .filter((declaration) => declaration.startsWith('content-visibility'));
  expect(applied).toEqual(['content-visibility: visible !important']);
}, 30_000);
