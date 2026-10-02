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
import { COMPACTION_DIVIDER_TEXT } from '../../src/components/chat/compaction-divider';
import { MessageList } from '../../src/components/chat/message-list';
import { TopBar } from '../../src/components/layout/top-bar';
import { ApiError } from '../../src/lib/api-client';
import { alerts, button, cleanup, click, dialog, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
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
});
afterEach(async () => {
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
    expect(container.textContent).toContain('in place of the 2 earlier messages above');
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

describe('Compact conversation in the conversation menu', () => {
  const topBar = <TopBar sidebarOpen onOpenSidebar={vi.fn()} onOpenCommandPalette={vi.fn()} />;

  it('is offered only for a conversation', async () => {
    await mount(topBar, '/');
    expect(document.querySelector('button[aria-label="Compact conversation"]')).toBeNull();
  });

  it('compacts with optional instructions and closes', async () => {
    api.post.mockResolvedValue({ compaction });
    const { client } = await mount(topBar, '/chat/thread-1');
    await click(button('Compact conversation'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Compact conversation');
    const field = dialog()!.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(field, '  keep the budget figures ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Compact'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-1/compact', {
      instructions: 'keep the budget figures',
    });
    expect(dialog()).toBeNull();
    // The thread view's summary is updated without a refetch.
    expect(client.getQueryData(['thread', 'thread-1', 'compaction'])).toEqual({ compaction });
  });

  it('sends no instructions when left empty, and shows why it was refused', async () => {
    api.post.mockRejectedValue(
      new ApiError(
        409,
        'CONFLICT',
        'Wait for the current reply to finish before compacting the conversation',
      ),
    );
    await mount(topBar, '/chat/thread-1');
    await click(button('Compact conversation'));
    await click(button('Compact'));
    expect(api.post).toHaveBeenCalledWith('/threads/thread-1/compact', {});
    expect(alerts()).toEqual([
      'Wait for the current reply to finish before compacting the conversation',
    ]);
    expect(dialog()).not.toBeNull();
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
  });
});
