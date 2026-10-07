// @vitest-environment happy-dom
import type { ConversationCompaction } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPACT_ACTION_LABEL,
  COMPACTION_PENDING_TEXT,
} from '../../src/components/chat/compact-thread-dialog';
import { COMPACTION_DIVIDER_TEXT } from '../../src/components/chat/compaction-divider';
import {
  COMPACTION_FAILED_TEXT,
  COMPACTION_FAILURE_TEXT,
  CompactionFailureNotice,
} from '../../src/components/chat/compaction-failure-notice';
import { MessageList } from '../../src/components/chat/message-list';
import { TopBar } from '../../src/components/layout/top-bar';
import { COMPACTION_POLL_MS, COMPACTION_POLL_WINDOW_MS } from '../../src/hooks/use-compaction';
import { summaryModelChoice, usePublishSummaryModel } from '../../src/hooks/use-summary-model';
import { ApiError } from '../../src/lib/api-client';
import { alerts, button, cleanup, click, dialog, findButton, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({
    data: { features: { temporaryChat: true, shareLinks: false, projects: false } },
  }),
}));
vi.mock('../../src/components/layout/theme-menu', () => ({ ThemeMenu: () => null }));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
}));

const compaction: ConversationCompaction = {
  id: 'compaction-1',
  threadId: 'thread-1',
  firstKeptMessageId: 'q2',
  summary: '## Topic and goal\nPlanning the BUDGET_SUMMARY',
  reason: 'automatic',
  messagesSummarized: 2,
  tokensSummarized: 900,
  modelSlug: 'model-a',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const message = (id: string, role: UIMessage['role']): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text: `${id} text` }],
});
const conversation = [
  message('q1', 'user'),
  message('a1', 'assistant'),
  message('q2', 'user'),
  message('a2', 'assistant'),
];

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.get.mockResolvedValue({ compaction: null, pending: false });
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) await cleanup(root);
  root = undefined;
});

async function mount(ui: ReactNode, path = '/') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Rendered by the matched route, so route parameters are in scope.
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => ui }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/chat/$threadId',
        component: () => ui,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return { container, client };
}

describe('compaction divider', () => {
  it('sits above the first kept message and expands to the summary', async () => {
    const { container } = await mount(
      <MessageList
        messages={conversation}
        streaming={false}
        onRetry={vi.fn()}
        compaction={compaction}
      />,
    );
    const divider = container.querySelector('[data-compaction-divider]');
    expect(divider?.textContent).toContain(COMPACTION_DIVIDER_TEXT);
    // Every message stays visible; the divider comes right before q2.
    const order = [
      ...container.querySelectorAll('[data-message-id], [data-compaction-divider]'),
    ].map((node) => node.getAttribute('data-message-id') ?? 'divider');
    expect(order).toEqual(['q1', 'a1', 'divider', 'q2', 'a2']);

    const toggle = button(`${COMPACTION_DIVIDER_TEXT}`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('BUDGET_SUMMARY');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('BUDGET_SUMMARY');
    expect(container.textContent).toContain(
      'in place of the 2 earlier messages above, which stay here unchanged',
    );
    await click(toggle);
    expect(container.textContent).not.toContain('BUDGET_SUMMARY');
  });

  it('is absent without a compaction or when its message is not shown', async () => {
    const { container } = await mount(
      <>
        <MessageList messages={conversation} streaming={false} onRetry={vi.fn()} />
        <MessageList
          messages={conversation}
          streaming={false}
          onRetry={vi.fn()}
          compaction={{ ...compaction, firstKeptMessageId: 'elsewhere' }}
        />
      </>,
    );
    expect(container.querySelector('[data-compaction-divider]')).toBeNull();
    expect(container.textContent).not.toContain(COMPACTION_DIVIDER_TEXT);
  });
});

describe('Summarise earlier messages now', () => {
  const topBar = <TopBar sidebarOpen onOpenSidebar={vi.fn()} onOpenCommandPalette={vi.fn()} />;
  const control = () =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${COMPACT_ACTION_LABEL}"]`);
  const status = () => document.querySelector('[role="status"]')?.textContent ?? '';

  it('is offered only for a conversation', async () => {
    await mount(topBar, '/');
    expect(control()).toBeNull();
  });

  it('queues the summary with optional instructions, closes at once and shows it is being made', async () => {
    api.post.mockResolvedValue({ compaction: null, pending: true });
    const { client } = await mount(topBar, '/chat/thread-1');
    expect(control()?.title).toBe(COMPACT_ACTION_LABEL);
    expect(status()).toBe('');
    await click(button(COMPACT_ACTION_LABEL));
    expect(dialog()?.querySelector('h2')?.textContent).toBe(COMPACT_ACTION_LABEL);
    expect(dialog()?.textContent).toContain('You can keep writing meanwhile');
    const field = dialog()!.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(field, '  keep the budget figures ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Checked on while pending, without waiting in real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await click(button('Summarise'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-1/compact', {
      instructions: 'keep the budget figures',
    });
    // Closed straight away: nothing waits for the summary.
    expect(dialog()).toBeNull();
    expect(client.getQueryData(['thread', 'thread-1', 'compaction'])).toEqual({
      compaction: null,
      pending: true,
    });
    expect(control()?.title).toBe(COMPACTION_PENDING_TEXT);
    expect(control()?.hasAttribute('data-compaction-pending')).toBe(true);
    expect(status()).toBe(COMPACTION_PENDING_TEXT);

    // Done in the background: the next check shows the summary.
    api.get.mockResolvedValue({ compaction, pending: false });
    const reads = api.get.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(COMPACTION_POLL_MS);
    });
    await settle();
    expect(api.get.mock.calls.length).toBeGreaterThan(reads);
    expect(client.getQueryData(['thread', 'thread-1', 'compaction'])).toEqual({
      compaction,
      pending: false,
    });
    expect(control()?.title).toBe(COMPACT_ACTION_LABEL);
    expect(status()).toBe('');
  });

  it('says there is nothing to summarise yet before asking for instructions (#153)', async () => {
    // One question and one reply, as the API reports it.
    api.get.mockResolvedValue({
      compaction: null,
      pending: false,
      failure: null,
      summarisable: false,
    });
    const { client } = await mount(topBar, '/chat/thread-one');
    expect(control()?.title).toBe('Nothing to summarise yet');
    await click(button(COMPACT_ACTION_LABEL));
    expect(dialog()?.querySelector('h2')?.textContent).toBe(COMPACT_ACTION_LABEL);
    expect(dialog()?.textContent).toContain(
      'There is nothing to summarise yet. A conversation needs at least two turns',
    );
    expect(dialog()?.querySelector('textarea')).toBeNull();
    expect(findButton('Summarise')).toBeUndefined();
    // One control named Close, and it has focus (#246): an × beside it was
    // a second "Close", and took focus first.
    const closes = [...dialog()!.querySelectorAll('button')].filter(
      (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === 'Close',
    );
    expect(closes).toHaveLength(1);
    expect(document.activeElement).toBe(closes[0]);
    await click(button('Close'));
    expect(dialog()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();

    // After a second exchange the state (read again after each reply) allows it.
    api.get.mockResolvedValue({
      compaction: null,
      pending: false,
      failure: null,
      summarisable: true,
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['thread', 'thread-one', 'compaction'] });
    });
    await settle();
    expect(control()?.title).toBe(COMPACT_ACTION_LABEL);
    await click(button(COMPACT_ACTION_LABEL));
    expect(dialog()?.querySelector('textarea')).not.toBeNull();
  });

  it('stops checking after a while when the summary takes long', async () => {
    api.get.mockResolvedValue({ compaction: null, pending: true });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await mount(topBar, '/chat/thread-2');
    expect(status()).toBe(COMPACTION_PENDING_TEXT);
    const tick = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      await settle();
    };
    // It checks on every interval while the window lasts…
    const first = api.get.mock.calls.length;
    await tick(COMPACTION_POLL_MS);
    await tick(COMPACTION_POLL_MS);
    expect(api.get.mock.calls.length).toBe(first + 2);
    // …then stops; the next reply reads the state again.
    await tick(COMPACTION_POLL_WINDOW_MS);
    const reads = api.get.mock.calls.length;
    await tick(COMPACTION_POLL_MS);
    await tick(COMPACTION_POLL_MS);
    expect(api.get.mock.calls.length).toBe(reads);
  });

  it('says a summary is already being made, and a repeat is accepted', async () => {
    api.get.mockResolvedValue({ compaction: null, pending: true });
    api.post.mockResolvedValue({ compaction: null, pending: true });
    await mount(topBar, '/chat/thread-3');
    await click(button(COMPACT_ACTION_LABEL));
    expect(dialog()?.textContent).toContain(COMPACTION_PENDING_TEXT);
    await click(button('Summarise'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-3/compact', {});
    expect(dialog()).toBeNull();
  });

  it('shows why a request was refused and stays open', async () => {
    api.post.mockRejectedValue(
      new ApiError(
        429,
        'QUOTA_EXCEEDED',
        'Your usage allowance is used up, so earlier messages cannot be summarised now.',
      ),
    );
    await mount(topBar, '/chat/thread-1');
    await click(button(COMPACT_ACTION_LABEL));
    await click(button('Summarise'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-1/compact', {});
    expect(alerts()).toEqual([
      'Your usage allowance is used up, so earlier messages cannot be summarised now.',
    ]);
    expect(dialog()).not.toBeNull();
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
  });
});

describe('a failed summary', () => {
  const failure = {
    reason: 'model_error' as const,
    instructions: 'keep the budget figures',
    failedAt: '2026-01-01T00:00:00.000Z',
  };
  const notice = () => document.querySelector<HTMLElement>('[data-compaction-failure]');

  it('is reported quietly with the reason, and Retry asks again with the same instructions', async () => {
    api.get.mockResolvedValue({ compaction: null, pending: false, failure });
    api.post.mockResolvedValue({ compaction: null, pending: true, failure: null });
    const { client } = await mount(
      <CompactionFailureNotice threadId="thread-1" />,
      '/chat/thread-1',
    );
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(notice()?.textContent).toContain(COMPACTION_FAILED_TEXT);
    expect(notice()?.textContent).toContain(COMPACTION_FAILURE_TEXT.model_error);
    await click(button('Retry'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-1/compact', {
      instructions: 'keep the budget figures',
    });
    expect(client.getQueryData(['thread', 'thread-1', 'compaction'])).toMatchObject({
      pending: true,
      failure: null,
    });
    expect(notice()).toBeNull();
  });

  it('is dismissed, and says when dismissing or retrying did not work', async () => {
    api.get.mockResolvedValue({
      compaction: null,
      pending: false,
      failure: { ...failure, reason: 'allowance', instructions: null },
    });
    api.post.mockRejectedValue(
      new ApiError(429, 'QUOTA_EXCEEDED', 'Your usage allowance is used up.'),
    );
    await mount(<CompactionFailureNotice threadId="thread-2" />, '/chat/thread-2');
    expect(notice()?.textContent).toContain(COMPACTION_FAILURE_TEXT.allowance);
    await click(button('Retry'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-2/compact', {});
    expect(alerts()).toEqual(['Your usage allowance is used up.']);
    api.delete.mockResolvedValue({ compaction: null, pending: false, failure: null });
    await click(button('Dismiss'));
    expect(api.delete).toHaveBeenCalledWith('/threads/thread-2/compaction/failure');
    expect(notice()).toBeNull();
  });

  it('offers no Retry when there was nothing to summarise, and shows nothing without a failure', async () => {
    api.get.mockResolvedValue({
      compaction: null,
      pending: false,
      failure: { ...failure, reason: 'nothing_to_summarise' },
    });
    await mount(<CompactionFailureNotice threadId="thread-3" />, '/chat/thread-3');
    expect(notice()?.textContent).toContain(COMPACTION_FAILURE_TEXT.nothing_to_summarise);
    expect([...notice()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Dismiss',
    ]);
    await cleanup(root!);
    root = undefined;
    // An older API without the field.
    api.get.mockResolvedValue({ compaction: null, pending: false });
    await mount(<CompactionFailureNotice threadId="thread-4" />, '/chat/thread-4');
    expect(notice()).toBeNull();
  });

  it('names every reason', () => {
    expect(Object.keys(COMPACTION_FAILURE_TEXT).sort()).toEqual([
      'allowance',
      'model_error',
      'nothing_to_summarise',
      'timeout',
    ]);
  });
});

describe('the model a summary is made with (#363)', () => {
  const reply = (id: string, modelSlug: string, status: 'complete' | 'error'): UIMessage => ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: '' }],
    metadata: {
      modelSlug,
      status,
      ...(status === 'error' ? { errorMessage: 'The model returned an error.' } : {}),
    },
  });
  const failed = [message('q1', 'user'), reply('a1', 'catalog-alpha', 'error')];
  const worked = [message('q1', 'user'), reply('a1', 'catalog-alpha', 'complete')];

  it('is the picker’s model, unless that is the model whose latest reply failed', () => {
    expect(summaryModelChoice(worked, 'catalog-alpha')).toBe('catalog-alpha');
    expect(summaryModelChoice(worked, 'catalog-beta')).toBe('catalog-beta');
    // Another model chosen in the picker is used even after a failure.
    expect(summaryModelChoice(failed, 'catalog-beta')).toBe('catalog-beta');
    // The same model again would fail the same way: the server picks the default.
    expect(summaryModelChoice(failed, 'catalog-alpha')).toBeNull();
    expect(summaryModelChoice(failed, null)).toBeNull();
    // Only the latest reply counts: an earlier failure is behind a good reply.
    expect(
      summaryModelChoice(
        [...failed, message('q2', 'user'), reply('a2', 'catalog-alpha', 'complete')],
        'catalog-alpha',
      ),
    ).toBe('catalog-alpha');
    expect(summaryModelChoice([message('q1', 'user')], 'catalog-alpha')).toBe('catalog-alpha');
  });

  function Conversation({ messages, picked }: { messages: UIMessage[]; picked: string }) {
    usePublishSummaryModel('thread-9', messages, picked);
    return <TopBar sidebarOpen onOpenSidebar={vi.fn()} onOpenCommandPalette={vi.fn()} />;
  }

  async function summarise() {
    await click(button(COMPACT_ACTION_LABEL));
    await click(button('Summarise'));
  }

  it('is sent with the request from the top bar: the picker’s model', async () => {
    api.post.mockResolvedValue({ compaction: null, pending: true });
    await mount(<Conversation messages={failed} picked="catalog-beta" />, '/chat/thread-9');
    await summarise();
    expect(api.post).toHaveBeenCalledWith('/threads/thread-9/compact', {
      modelSlug: 'catalog-beta',
    });
  });

  it('names no model when the picker still holds the one that failed', async () => {
    api.post.mockResolvedValue({ compaction: null, pending: true });
    await mount(<Conversation messages={failed} picked="catalog-alpha" />, '/chat/thread-9');
    await summarise();
    expect(api.post).toHaveBeenCalledWith('/threads/thread-9/compact', {});
  });

  it('is what Retry sends too, and the note says what to do', async () => {
    api.get.mockResolvedValue({
      compaction: null,
      pending: false,
      failure: {
        reason: 'model_error',
        instructions: 'keep the figures',
        failedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    api.post.mockResolvedValue({ compaction: null, pending: true, failure: null });
    function Retrying() {
      usePublishSummaryModel('thread-9', failed, 'catalog-beta');
      return <CompactionFailureNotice threadId="thread-9" />;
    }
    await mount(<Retrying />, '/chat/thread-9');
    const note = document.querySelector('[data-compaction-failure]')?.textContent ?? '';
    expect(note).toContain('Choose another model');
    expect(note).toContain('Retry');
    await click(button('Retry'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-9/compact', {
      instructions: 'keep the figures',
      modelSlug: 'catalog-beta',
    });
  });

  it('is forgotten when the conversation closes', async () => {
    api.post.mockResolvedValue({ compaction: null, pending: true });
    function Closing() {
      usePublishSummaryModel('thread-9', worked, 'catalog-alpha');
      return null;
    }
    await mount(<Closing />, '/chat/thread-9');
    await cleanup(root!);
    root = undefined;
    await mount(
      <TopBar sidebarOpen onOpenSidebar={vi.fn()} onOpenCommandPalette={vi.fn()} />,
      '/chat/thread-9',
    );
    await summarise();
    expect(api.post).toHaveBeenCalledWith('/threads/thread-9/compact', {});
  });
});
