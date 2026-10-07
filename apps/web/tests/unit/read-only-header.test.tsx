// @vitest-environment happy-dom
import { INACTIVE_READ_ONLY_STATUS, type ReadOnlyStatus, type ThreadSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COMPACT_ACTION_LABEL } from '../../src/components/chat/compact-thread-dialog';
import { SidebarProjects } from '../../src/components/layout/sidebar-projects';
import { ThreadList } from '../../src/components/layout/thread-list';
import { TopBar } from '../../src/components/layout/top-bar';
import { setReadOnlyStatus } from '../../src/lib/read-only';
import { button, click, dialog, expectLocked, isOff, settle } from './admin-test-utils';

/**
 * Read-only mode turns off every change on the conversation screen, with the
 * reason, as it does the sidebar's Pin, Rename and Archive (#331). The
 * header's Rename, Share and Move to project, its Summarise, and the
 * sidebar's New project stayed on, so a person filled in a dialog only to be
 * refused. The real top bar, sidebar and read-only store run here, in a real
 * router and query client; only the API answers are fixed.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/layout/theme-menu', () => ({ ThemeMenu: () => null }));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
}));

const NOW = new Date().toISOString();
const UNTIL = new Date(Date.now() + 60 * 60_000).toISOString();
const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Fix7 check',
  until: UNTIL,
  window: null,
};
const thread: ThreadSummary = {
  id: 't1',
  title: 'Trip plans',
  pinned: false,
  archived: false,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId: null,
  lastMessageAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

let root: Root | undefined;

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'me', name: 'Pat' },
        features: { projects: true, shareLinks: true, temporaryChat: true },
      };
    if (path === '/threads?view=sidebar') return { threads: [thread] };
    if (path === '/projects/sidebar') return { projects: [] };
    if (path.endsWith('/compaction')) return { compaction: null, pending: false };
    if (path.startsWith('/share-links/threads/')) return { links: [] };
    if (path.startsWith('/chat/')) return { messages: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS);
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  root = undefined;
  document.body.innerHTML = '';
});

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: 'shell',
    component: () => (
      <>
        <TopBar sidebarOpen onOpenSidebar={vi.fn()} onOpenCommandPalette={vi.fn()} />
        <nav>
          <SidebarProjects />
          <ThreadList />
        </nav>
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([
        createRoute({
          getParentRoute: () => shell,
          path: '/chat/$threadId',
          component: () => null,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ['/chat/t1'] }),
  });
  await act(async () => {
    await router.load();
  });
  const mounted = root;
  await act(async () =>
    mounted.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** Every control that changes something on this screen, by accessible name. */
const WRITE_CONTROLS = [
  'Rename conversation',
  'Share conversation',
  'Move to project',
  COMPACT_ACTION_LABEL,
  'New project',
  // The sidebar's own, which were already off (#159): the others must match them.
  'Rename conversation: Trip plans',
  'Pin conversation: Trip plans',
];

const SIDEBAR_ROW_ACTIONS = ['Rename conversation: Trip plans', 'Pin conversation: Trip plans'];

it('turns the header and sidebar changes off with the reason, and back on afterwards', async () => {
  setReadOnlyStatus(ON);
  await render();
  for (const name of WRITE_CONTROLS) {
    const control = button(name);
    if (SIDEBAR_ROW_ACTIONS.includes(name)) {
      // The sidebar rows' own buttons (#159) are natively disabled.
      expect(control.disabled, name).toBe(true);
      expect(control.title, name).toMatch(/^Read-only for maintenance until about /);
    } else {
      // The rest are focusable and described by the reason (#357).
      expectLocked(control, /^Read-only for maintenance until about /, name);
    }
  }
  // Reading and taking a copy stay available.
  const download = document.querySelector('a[aria-label="Download this conversation"]');
  expect(download?.getAttribute('href')).toContain('/export');

  await act(async () => setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS));
  await settle();
  for (const name of WRITE_CONTROLS) expect(isOff(button(name)), name).toBe(false);
  expect(button('Rename conversation').title).toBe('Rename');
  expect(button('New project').title).toBe('New project');
});

it('turns off creating a link in a Share dialog left open when read-only starts', async () => {
  await render();
  await click(button('Share conversation'));
  expect(dialog()).not.toBeNull();
  expect(isOff(button('Create and copy link'))).toBe(false);

  await act(async () => setReadOnlyStatus(ON));
  await settle();
  expectLocked(button('Create and copy link'), /^Read-only for maintenance/);
});
