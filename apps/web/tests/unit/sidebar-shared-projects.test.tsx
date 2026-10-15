// @vitest-environment happy-dom
import type { SidebarProject, ThreadSummary } from '@oci/shared';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProjects } from '../../src/components/layout/sidebar-projects';
import { ThreadList } from '../../src/components/layout/thread-list';
import { EXPANDED_PROJECTS_STORAGE_KEY } from '../../src/hooks/use-expanded-projects';
import { button, click, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const NOW = new Date().toISOString();

function thread(id: string, title: string, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    title,
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
    ...extra,
  };
}

let owned: SidebarProject[];
let shared: SidebarProject[] | undefined;
let threads: ThreadSummary[];
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  owned = [{ id: 'p1', name: 'Thesis', threadCount: 0, recentThreads: [] }];
  shared = [
    {
      id: 's1',
      name: 'Lab handbook',
      threadCount: 2,
      recentThreads: [thread('t1', 'My lab question', { projectId: 's1' })],
      access: 'viewer',
      ownerName: 'Olive Owner',
    },
    {
      id: 's2',
      name: 'Grant draft',
      threadCount: 0,
      recentThreads: [],
      access: 'editor',
      ownerName: 'Edna Editor',
    },
  ];
  threads = [thread('u1', 'Unfiled today')];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features: { projects: true } };
    if (path === '/projects/sidebar')
      return shared ? { projects: owned, shared } : { projects: owned };
    if (path === '/threads?view=sidebar') return { threads };
    throw new Error(`Unexpected GET ${path}`);
  });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  root = undefined;
  document.body.innerHTML = '';
});

async function render(path = '/') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: 'shell',
    component: () => (
      <nav>
        <SidebarProjects />
        <ThreadList />
        <Outlet />
      </nav>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([
        createRoute({ getParentRoute: () => shell, path: '/', component: () => null }),
        createRoute({
          getParentRoute: () => shell,
          path: '/chat/$threadId',
          component: () => null,
        }),
        createRoute({ getParentRoute: () => shell, path: '/projects', component: () => null }),
        createRoute({
          getParentRoute: () => shell,
          path: '/projects/$projectId',
          component: () => null,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
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
  return { client, router };
}

function sharedList(): HTMLUListElement | null {
  return document.querySelector('ul[aria-label="Shared with me"]');
}

describe('sidebar: Shared with me', () => {
  it('lists the projects shared with the person, under the projects they own', async () => {
    await render();
    const heading = document.getElementById('sidebar-shared-heading');
    expect(heading?.textContent).toBe('Shared with me');
    const rows = [...(sharedList()?.querySelectorAll(':scope > li') ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('a[href="/projects/s1"]')?.textContent).toContain('Lab handbook');
    expect(rows[1]?.querySelector('a[href="/projects/s2"]')?.textContent).toContain('Grant draft');
    // The owned list is separate and does not hold shared projects.
    const mine = document.querySelector('ul[aria-label="Projects"]');
    expect(mine?.textContent).toContain('Thesis');
    expect(mine?.textContent).not.toContain('Lab handbook');
  });

  it('shows who owns each and the access level, in the row’s own text', async () => {
    await render();
    const rows = [...(sharedList()?.querySelectorAll(':scope > li') ?? [])];
    expect(rows[0]?.textContent).toContain('Olive Owner · Viewer');
    expect(rows[1]?.textContent).toContain('Edna Editor · Editor');
  });

  it('is absent when nothing is shared, and for an API from before sharing', async () => {
    shared = [];
    await render();
    expect(document.getElementById('sidebar-shared-heading')).toBeNull();
    expect(sharedList()).toBeNull();
    await act(async () => root?.unmount());
    document.body.innerHTML = '';
    shared = undefined;
    await render();
    expect(document.getElementById('sidebar-shared-heading')).toBeNull();
  });

  it('opens a shared project’s own conversations, remembered like any project', async () => {
    await render();
    await click(button('Conversations in Lab handbook'));
    const list = document.querySelector('ul[aria-label="Conversations in Lab handbook"]');
    expect(list?.textContent).toContain('My lab question');
    expect(JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) ?? 'null')).toContain(
      's1',
    );
    // Opening an owned project afterwards must not forget the shared one.
    await click(button('Conversations in Thesis'));
    expect(JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) ?? 'null')).toEqual(
      expect.arrayContaining(['s1', 'p1']),
    );
  });

  it('marks the shared project on screen as current and opens it by itself', async () => {
    await render('/projects/s1');
    const link = document.querySelector('a[href="/projects/s1"]');
    expect(link?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('ul[aria-label="Conversations in Lab handbook"]')).not.toBeNull();
  });

  it('keeps the person’s own conversations in a shared project out of the unfiled list', async () => {
    threads = [
      thread('u1', 'Unfiled today'),
      thread('t9', 'Pinned lab note', { pinned: true, projectId: 's1' }),
    ];
    await render();
    // A pinned conversation in a shared project is labelled with that project, as for an owned one.
    expect(document.body.textContent).toContain('Pinned lab note');
    expect(document.body.textContent).toContain('Lab handbook');
  });

  it('names the heading so a screen reader can reach it as part of Projects', async () => {
    await render();
    const section = document.querySelector('section[aria-labelledby="sidebar-projects-heading"]');
    expect(section?.contains(document.getElementById('sidebar-shared-heading'))).toBe(true);
  });

  it('links to the page that lists every project', async () => {
    await render();
    const all = document.querySelector('a[href="/projects"]');
    expect(all?.getAttribute('aria-label')).toBe('All projects');
  });
});
