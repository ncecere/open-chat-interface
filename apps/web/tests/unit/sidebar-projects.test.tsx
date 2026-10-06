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
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProjects } from '../../src/components/layout/sidebar-projects';
import { ThreadList } from '../../src/components/layout/thread-list';
import { EXPANDED_PROJECTS_STORAGE_KEY } from '../../src/hooks/use-expanded-projects';
import { useMoveThread } from '../../src/hooks/use-projects';
import { useCreateThread } from '../../src/hooks/use-threads';
import { chatHistoryKey } from '../../src/lib/conversation-cache';
import { button, click, settle } from './admin-test-utils';
import { styleFor, toPx } from './css-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const NOW = new Date().toISOString();
const LONG_AGO = '2025-01-01T00:00:00.000Z';

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

const THESIS_RECENT = [1, 2, 3, 4, 5].map((index) =>
  thread(`t${index}`, `Chapter ${index}`, { projectId: 'p1' }),
);

let projects: SidebarProject[];
let threads: ThreadSummary[];
let features: Record<string, boolean>;
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  features = { projects: true };
  projects = [
    { id: 'p2', name: 'Grants', threadCount: 1, recentThreads: [] },
    { id: 'p3', name: 'Empty', threadCount: 0, recentThreads: [] },
    { id: 'p1', name: 'Thesis', threadCount: 8, recentThreads: THESIS_RECENT },
  ];
  threads = [
    thread('pg', 'Pinned grant', { pinned: true, projectId: 'p2' }),
    thread('u1', 'Unfiled today'),
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features };
    if (path === '/projects/sidebar') return { projects };
    if (path === '/threads?view=sidebar') return { threads };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset();
  api.patch.mockReset();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  root = undefined;
  document.body.innerHTML = '';
});

/** The sidebar's nav as sidebar.tsx renders it, inside a layout route like AppShell. */
async function render(
  path = '/',
  { extra, seed }: { extra?: ReactNode; seed?: (client: QueryClient) => void } = {},
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  seed?.(client);
  const rootRoute = createRootRoute();
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: 'shell',
    component: () => (
      <nav>
        <SidebarProjects />
        <ThreadList />
        {extra}
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

async function remount(path = '/') {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  document.body.innerHTML = '';
  return render(path);
}

function toggle(name: string): HTMLButtonElement {
  return button(`Conversations in ${name}`);
}

function projectList(name: string): HTMLUListElement | null {
  return document.querySelector(`ul[aria-label="Conversations in ${name}"]`);
}

function titles(list: ParentNode | null): string[] {
  return [...(list?.querySelectorAll('a[href^="/chat/"]:not([aria-label])') ?? [])].map(
    (link) => link.querySelector('span')?.textContent ?? '',
  );
}

function link(text: string): HTMLAnchorElement | undefined {
  return [...document.querySelectorAll('a')].find((candidate) =>
    candidate.textContent?.startsWith(text),
  );
}

function stored(): unknown {
  return JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) ?? 'null');
}

/** The general list: everything after the Projects section. */
function generalList(): HTMLElement {
  const section = document.querySelector('section[aria-labelledby="sidebar-projects-heading"]');
  const next = section?.nextElementSibling;
  if (!(next instanceof HTMLElement)) throw new Error('No general list');
  return next;
}

describe('sidebar projects', () => {
  it('heads the section with a plain Projects heading and a New project button', async () => {
    await render();
    const heading = document.querySelector('h2#sidebar-projects-heading');
    expect(heading?.textContent).toBe('Projects');
    expect(heading?.closest('button')).toBeNull();
    expect(button('New project')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Projects')).toBe(
      false,
    );
    // Projects keep their name order from the server, each with a page link.
    const names = [...document.querySelectorAll('ul[aria-label="Projects"] > li > div a')].map(
      (anchor) => anchor.textContent,
    );
    expect(names).toEqual(['Grants', 'Empty', 'Thesis']);
    expect(link('Thesis')?.getAttribute('href')).toBe('/projects/p1');
  });

  it('starts every project collapsed', async () => {
    await render();
    for (const name of ['Grants', 'Empty', 'Thesis']) {
      const control = toggle(name);
      expect(control.getAttribute('aria-expanded')).toBe('false');
      const panel = document.getElementById(control.getAttribute('aria-controls') ?? '');
      expect(panel?.hidden).toBe(true);
      expect(projectList(name)).toBeNull();
    }
    expect(link('Chapter 1')).toBeUndefined();
  });

  it('shows the five newest and Show all (N), and remembers the choice in this browser', async () => {
    await render();
    await click(toggle('Thesis'));

    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    expect(titles(projectList('Thesis'))).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
      'Chapter 5',
    ]);
    // Rows carry no project label under their own project.
    expect(projectList('Thesis')?.textContent).not.toContain('in project');
    const showAll = link('Show all (8)');
    expect(showAll?.textContent).toBe('Show all (8) conversations in Thesis');
    expect(showAll?.getAttribute('href')).toMatch(/^\/projects\/p1(\?tab=conversations)?$/);
    expect(stored()).toEqual(['p1']);

    await remount();
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    expect(titles(projectList('Thesis'))).toHaveLength(5);

    await click(toggle('Thesis'));
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');
    expect(stored()).toEqual([]);
  });

  it('tolerates stale and malformed stored ids, dropping them on the next save', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(['deleted', 'p1', 7]));
    await render();
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    await click(toggle('Empty'));
    expect(stored()).toEqual(['p1', 'p3']);

    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, '{not json');
    await remount();
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');
  });

  it('follows projects opened and closed in another tab', async () => {
    await render();
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');

    // Another tab writes the key; the browser tells this tab with a storage event.
    const otherTab = async (
      value: string | null,
      key: string | null = EXPANDED_PROJECTS_STORAGE_KEY,
    ) => {
      if (key === EXPANDED_PROJECTS_STORAGE_KEY && value !== null) localStorage.setItem(key, value);
      if (key === null) localStorage.clear();
      await act(async () => {
        window.dispatchEvent(
          new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }),
        );
      });
      await settle();
    };

    await otherTab(JSON.stringify(['p1', 'p2']));
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Grants').getAttribute('aria-expanded')).toBe('true');
    expect(titles(projectList('Thesis'))).toHaveLength(5);

    await otherTab(JSON.stringify(['p2']));
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Grants').getAttribute('aria-expanded')).toBe('true');

    // Other keys are ignored; clearing storage collapses everything.
    localStorage.setItem('oci.unrelated', '1');
    await otherTab('1', 'oci.unrelated');
    expect(toggle('Grants').getAttribute('aria-expanded')).toBe('true');
    await otherTab(null, null);
    expect(toggle('Grants').getAttribute('aria-expanded')).toBe('false');

    // A toggle here after a sync builds on what the other tab chose.
    await otherTab(JSON.stringify(['p3']));
    await click(toggle('Thesis'));
    expect(stored()).toEqual(['p3', 'p1']);
  });

  it('stops listening for other tabs once unmounted', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    await render();
    await act(() => root!.unmount());
    root = undefined;
    expect(remove.mock.calls.some(([type]) => type === 'storage')).toBe(true);
    remove.mockRestore();
  });

  it('lists a pinned project conversation only in Pinned, still counted in Show all', async () => {
    await render();
    await click(toggle('Grants'));
    expect(projectList('Grants')).toBeNull();
    expect(link('Show all (1)')?.getAttribute('href')).toMatch(/^\/projects\/p2/);

    const pinned = link('Pinned grant');
    expect(pinned?.textContent).toBe('Pinned grant, in project Grants');
    expect(document.querySelectorAll('a[href="/chat/pg"]')).toHaveLength(1);

    await click(toggle('Empty'));
    const empty = document.getElementById(toggle('Empty').getAttribute('aria-controls') ?? '');
    expect(empty?.textContent).toBe('No conversations');
    expect(empty?.textContent).not.toContain('Show all');
  });

  it('keeps project conversations out of the general list and drops its project label', async () => {
    threads = [
      ...threads,
      thread('u2', 'Older unfiled', { updatedAt: LONG_AGO, lastMessageAt: LONG_AGO }),
    ];
    await render();
    const general = generalList();
    expect(general.textContent).toContain('Unfiled today');
    expect(general.textContent).toContain('Older');
    expect(general.textContent).not.toContain('Chapter');
    // Only the pinned row is labelled.
    expect(general.querySelectorAll('.sr-only')).toHaveLength(1);
  });

  it('opens the project of the project page without remembering it', async () => {
    await render('/projects/p1');
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    expect(link('Thesis')?.getAttribute('aria-current')).toBe('page');
    expect(stored()).toBeNull();

    // Closing it by hand wins for this visit and is not saved as open.
    await click(toggle('Thesis'));
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');
    expect(stored()).toEqual([]);
    await click(toggle('Thesis'));
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    expect(stored()).toEqual(['p1']);
  });

  it('goes back to the stored state when the page moves on', async () => {
    const { router } = await render('/projects/p1');
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      await router.navigate({ to: '/' });
    });
    await settle();
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the project of the open conversation and highlights it', async () => {
    await render('/chat/t3');
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    const rows = projectList('Thesis');
    expect(titles(rows)).toHaveLength(5);
    expect(rows?.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/chat/t3');
  });

  it('adds an open conversation older than the newest five as an extra row', async () => {
    await render('/chat/old', {
      seed: (client) =>
        client.setQueryData(chatHistoryKey('old'), {
          thread: thread('old', 'Old chapter', {
            projectId: 'p1',
            updatedAt: LONG_AGO,
            lastMessageAt: LONG_AGO,
          }),
          messages: [],
          replies: [],
        }),
    });
    expect(toggle('Thesis').getAttribute('aria-expanded')).toBe('true');
    const rows = projectList('Thesis');
    expect(titles(rows)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
      'Chapter 5',
      'Old chapter',
    ]);
    expect(rows?.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/chat/old');
    expect(link('Show all (8)')).toBeTruthy();
    // Nowhere else in the sidebar.
    expect(document.querySelectorAll('a[href="/chat/old"]')).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  it('has no Projects section when the role cannot use projects', async () => {
    features = { projects: false };
    await render();
    expect(document.getElementById('sidebar-projects-heading')).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/projects/sidebar');
    expect(generalList).toThrow();
    expect(document.body.textContent).toContain('Unfiled today');
  });
});

describe('sidebar general list', () => {
  /** The size of a box from its compiled classes: its own, else its padding round its icon. */
  async function targetSize(element: Element) {
    const style = await styleFor(element.getAttribute('class') ?? '');
    const icon = await styleFor(element.querySelector('svg')?.getAttribute('class') ?? '');
    const padding = 2 * toPx(style.padding);
    return {
      width: style.width ? toPx(style.width) : toPx(icon.width) + padding,
      height: style.height ? toPx(style.height) : toPx(icon.height) + padding,
    };
  }

  it('makes "Go to parent thread" a 24 × 24 target (#193)', async () => {
    threads = [thread('f1', 'Forked plan', { parentThreadId: 'u1' })];
    await render();
    const parent = document.querySelector('a[title="Go to parent thread"]')!;
    expect(parent.getAttribute('aria-label')).toBe('Go to parent thread of: Forked plan');
    const size = await targetSize(parent);
    expect(size.width).toBeGreaterThanOrEqual(24);
    expect(size.height).toBeGreaterThanOrEqual(24);
  });

  it('heads every group, so heading navigation reaches each day (#198)', async () => {
    threads = [
      thread('pg', 'Pinned grant', { pinned: true, projectId: 'p2' }),
      thread('u1', 'Unfiled today'),
      thread('o1', 'Unfiled long ago', { lastMessageAt: LONG_AGO, createdAt: LONG_AGO }),
    ];
    await render();
    const headings = [...document.querySelectorAll('nav h2')].map((h) => h.textContent);
    expect(headings).toEqual(['Projects', 'Pinned', 'Today', 'Older']);
    // Pinned keeps its disclosure, inside the heading.
    const pinned = button('Pinned');
    expect(pinned.closest('h2')).not.toBeNull();
    expect(pinned.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('sidebar refresh after conversation changes', () => {
  function MoveHarness() {
    const move = useMoveThread();
    return (
      <button type="button" onClick={() => move.mutate({ threadId: 'u1', projectId: 'p3' })}>
        Move it
      </button>
    );
  }

  function CreateHarness() {
    const create = useCreateThread();
    return (
      <button type="button" onClick={() => create.mutate({ projectId: 'p3' })}>
        Create it
      </button>
    );
  }

  function calls(path: string) {
    return api.get.mock.calls.filter(([called]) => called === path).length;
  }

  it('moves a conversation from the general list to its new project', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(['p3']));
    const moved = thread('u1', 'Unfiled today', { projectId: 'p3' });
    api.patch.mockImplementation(async () => {
      threads = threads.filter((candidate) => candidate.id !== 'u1');
      projects = projects.map((project) =>
        project.id === 'p3' ? { ...project, threadCount: 1, recentThreads: [moved] } : project,
      );
      return { thread: moved };
    });
    await render('/', { extra: <MoveHarness /> });
    expect(generalList().textContent).toContain('Unfiled today');
    const before = [calls('/projects/sidebar'), calls('/threads?view=sidebar')];

    await click(button('Move it'));

    expect(api.patch).toHaveBeenCalledWith('/threads/u1', { projectId: 'p3' });
    expect(calls('/projects/sidebar')).toBe((before[0] ?? 0) + 1);
    expect(calls('/threads?view=sidebar')).toBe((before[1] ?? 0) + 1);
    expect(titles(projectList('Empty'))).toEqual(['Unfiled today']);
    expect(generalList().textContent).not.toContain('Unfiled today');
  });

  it('lists a conversation created in a project under it', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(['p3']));
    const created = thread('n1', 'New Chat', { projectId: 'p3' });
    api.post.mockImplementation(async () => {
      projects = projects.map((project) =>
        project.id === 'p3' ? { ...project, threadCount: 1, recentThreads: [created] } : project,
      );
      return { thread: created };
    });
    await render('/', { extra: <CreateHarness /> });
    expect(projectList('Empty')).toBeNull();

    await click(button('Create it'));

    expect(api.post).toHaveBeenCalledWith('/threads', { temporary: false, projectId: 'p3' });
    expect(titles(projectList('Empty'))).toEqual(['New Chat']);
  });
});

describe('sidebar projects during a database outage', () => {
  // "Projects could not be loaded" stayed after a 40 s outage was over, until
  // a reload (#233). The real query and QueryClient; the API answers 500 as
  // it did while PostgreSQL was away.
  it('loads the projects by itself once the outage is over', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    const { AUTO_RETRY_MS } = await import('../../src/hooks/use-auto-retry');
    let down = true;
    const normal = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (path: string) => {
      if (down && path === '/projects/sidebar')
        throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
      return normal(path);
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await render();
      expect(document.body.textContent).toContain('Projects could not be loaded.');
      await act(async () => {
        vi.advanceTimersByTime(AUTO_RETRY_MS);
      });
      await settle();
      expect(document.body.textContent).toContain('Projects could not be loaded.');

      down = false;
      await act(async () => {
        vi.advanceTimersByTime(AUTO_RETRY_MS);
      });
      await settle();
      expect(document.body.textContent).not.toContain('Projects could not be loaded.');
      expect(link('Thesis')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
