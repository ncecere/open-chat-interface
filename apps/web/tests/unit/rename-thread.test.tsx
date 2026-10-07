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
import { TopBar } from '../../src/components/layout/top-bar';
import { EXPANDED_PROJECTS_STORAGE_KEY } from '../../src/hooks/use-expanded-projects';
import { ApiError } from '../../src/lib/api-client';
import type { ChatHistory } from '../../src/lib/chat-history';
import { chatHistoryKey } from '../../src/lib/conversation-cache';
import { alerts, button, click, dialog, findButton, pressEscape, settle } from './admin-test-utils';

/**
 * Renaming a conversation from its sidebar row (general list and project
 * rows share it) and from the conversation's top bar. The API accepted a
 * title all along; nothing in the interface sent one.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/layout/theme-menu', () => ({ ThemeMenu: () => null }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
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

let threads: ThreadSummary[];
let projects: SidebarProject[];
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  threads = [thread('t1', 'Trip plans')];
  projects = [
    {
      id: 'p1',
      name: 'Thesis',
      threadCount: 1,
      recentThreads: [thread('t2', 'Chapter one', { projectId: 'p1' })],
    },
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') {
      return {
        user: { id: 'me', name: 'Pat' },
        features: { projects: true, shareLinks: false, temporaryChat: true },
      };
    }
    if (path === '/threads?view=sidebar') return { threads };
    if (path === '/projects/sidebar') return { projects };
    if (path.startsWith('/threads/') && path.endsWith('/compaction')) {
      return { compaction: null, pending: false };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockImplementation(async (path: string, body: { title: string }) => {
    const id = path.split('/')[2]!;
    threads = threads.map((item) => (item.id === id ? { ...item, title: body.title } : item));
    return { thread: { ...thread(id, body.title) } };
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
        createRoute({ getParentRoute: () => shell, path: '/', component: () => null }),
        createRoute({
          getParentRoute: () => shell,
          path: '/chat/$threadId',
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
  return { client };
}

function rowTitles(): string[] {
  return [...document.querySelectorAll('nav a[href^="/chat/"]')].map(
    (link) => link.querySelector('span')?.textContent ?? '',
  );
}

function nameInput(): HTMLInputElement {
  const input = dialog()?.querySelector('input');
  if (!input) throw new Error('No name field');
  return input;
}

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(nameInput(), value);
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/**
 * Enter in a single-field form submits it (implicit submission). happy-dom does
 * not implement that, so do what the browser does; the e2e suite presses Enter.
 */
async function pressEnter() {
  await act(async () => {
    nameInput().form?.requestSubmit();
  });
  await settle();
}

function renameButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Rename thread: "]')];
}

describe('renaming from the sidebar', () => {
  it('saves a trimmed name on Enter and shows it in the sidebar at once', async () => {
    await render();
    expect(rowTitles()).toContain('Trip plans');

    await click(renameButtons()[0]!);
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Rename conversation');
    expect(nameInput().value).toBe('Trip plans');
    expect(nameInput().maxLength).toBe(200);
    // The field is labelled, so it has an accessible name.
    const label = dialog()?.querySelector(`label[for="${nameInput().id}"]`);
    expect(label?.textContent).toBe('Name');

    await type('  Lisbon itinerary  ');
    await pressEnter();

    expect(api.patch).toHaveBeenCalledWith('/threads/t1', { title: 'Lisbon itinerary' });
    expect(dialog()).toBeNull();
    expect(rowTitles()).toContain('Lisbon itinerary');
    expect(rowTitles()).not.toContain('Trip plans');
  });

  it("names each row's controls for the row, not N copies of one name (#111)", async () => {
    await render();
    const labels = [...document.querySelectorAll('nav button[aria-label], button[aria-label]')]
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => / thread: /.test(label));
    expect(labels).toEqual(
      expect.arrayContaining([
        'Pin thread: Trip plans',
        'Rename thread: Trip plans',
        'Archive thread: Trip plans',
      ]),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('says a conversation was archived and offers Undo (#101, #125)', async () => {
    await render();
    // As the server does: an archived conversation drops out of the sidebar
    // list, so the refetch after archiving unmounts the row that asked. The
    // #101 test's fake kept the row, which hid that its notice never ran. The
    // project tree answers later than the list, as over a network, so the row
    // is gone before the mutation's refresh (both lists) has finished.
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (path: string) => {
      if (path === '/projects/sidebar') await new Promise((resolve) => setTimeout(resolve, 30));
      return get(path);
    });
    api.patch.mockImplementation(async (path: string, body: { archived: boolean }) => {
      const id = path.split('/')[2]!;
      const changed = thread(id, 'Trip plans', { archived: body.archived });
      threads = body.archived
        ? threads.filter((item) => item.id !== id)
        : [...threads.filter((item) => item.id !== id), changed];
      return { thread: changed };
    });
    toast.success.mockClear();
    await click(button('Archive thread: Trip plans'));
    expect(api.patch).toHaveBeenCalledWith('/threads/t1', { archived: true });
    await vi.waitFor(() => expect(rowTitles()).not.toContain('Trip plans'));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [message, options] = toast.success.mock.calls[0]!;
    expect(message).toBe('Conversation archived');
    expect(options.description).toBe('Trip plans');
    await act(async () => options.action.onClick());
    await settle();
    expect(api.patch).toHaveBeenLastCalledWith('/threads/t1', { archived: false });
    await vi.waitFor(() => expect(rowTitles()).toContain('Trip plans'));
  });

  it('cancels on Escape without saving', async () => {
    await render();
    await click(renameButtons()[0]!);
    await type('Something else');
    await pressEscape();

    expect(dialog()).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
    expect(rowTitles()).toContain('Trip plans');
  });

  it('will not save a blank name, and does not send an unchanged one', async () => {
    await render();
    await click(renameButtons()[0]!);
    await type('   ');
    const rename = [...(dialog() as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Rename',
    );
    expect(rename?.disabled).toBe(true);
    await pressEnter();
    expect(api.patch).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();

    await type(' Trip plans ');
    await pressEnter();
    expect(api.patch).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('keeps the dialog open with the reason when saving fails', async () => {
    api.patch.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Thread not found'));
    await render();
    await click(renameButtons()[0]!);
    await type('Gone');
    await pressEnter();

    expect(dialog()).not.toBeNull();
    expect(alerts(dialog() as HTMLElement)).toEqual(['Thread not found']);
  });

  it('is offered on project rows too', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(['p1']));
    await render();
    const projectRow = document.querySelector('ul[aria-label="Conversations in Thesis"]');
    const rename = projectRow?.querySelector<HTMLButtonElement>(
      'button[aria-label^="Rename thread: "]',
    );
    expect(rename).toBeTruthy();
    await click(rename!);
    expect(nameInput().value).toBe('Chapter one');
  });
});

describe('renaming from the top bar', () => {
  it('renames the open conversation and updates its cached history', async () => {
    const { client } = await render('/chat/t1');
    client.setQueryData<ChatHistory>(chatHistoryKey('t1'), {
      thread: thread('t1', 'Trip plans'),
      messages: [],
    } as unknown as ChatHistory);
    expect(findButton('Rename conversation')).toBeTruthy();

    await click(button('Rename conversation'));
    expect(nameInput().value).toBe('Trip plans');
    await type('Lisbon itinerary');
    await pressEnter();

    expect(api.patch).toHaveBeenCalledWith('/threads/t1', { title: 'Lisbon itinerary' });
    expect(client.getQueryData<ChatHistory>(chatHistoryKey('t1'))?.thread.title).toBe(
      'Lisbon itinerary',
    );
    expect(rowTitles()).toContain('Lisbon itinerary');
  });

  it('offers Move to project for a saved conversation but not a temporary one (#91)', async () => {
    const { client } = await render('/chat/tmp');
    expect(findButton('Move to project')).toBeTruthy();
    // A temporary chat the sidebar does not list: its history says what it is.
    await act(async () => {
      client.setQueryData<ChatHistory>(chatHistoryKey('tmp'), {
        thread: { ...thread('tmp', 'Walk temporary'), temporary: true },
        messages: [],
      } as unknown as ChatHistory);
    });
    expect(findButton('Move to project')).toBeUndefined();
    expect(findButton('Rename conversation')).toBeTruthy();
  });

  it('offers no conversation actions for one that does not exist (#103)', async () => {
    const { client } = await render('/chat/walk-does-not-exist');
    const action = (label: string) => document.querySelector(`[aria-label="${label}"]`);
    expect(action('Download this conversation')).not.toBeNull();
    expect(action('Rename conversation')).not.toBeNull();
    await act(async () => {
      await client.prefetchQuery({
        queryKey: chatHistoryKey('walk-does-not-exist'),
        queryFn: () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Thread not found')),
        retry: false,
      });
    });
    for (const label of ['Rename conversation', 'Download this conversation', 'Move to project'])
      expect(action(label), label).toBeNull();
    // The page's own controls stay.
    expect(action('Start temporary chat')).not.toBeNull();
  });

  it('is not shown away from a conversation', async () => {
    await render('/');
    expect(findButton('Rename conversation')).toBeUndefined();
  });
});

describe('temporary chat for a role without it (#181)', () => {
  it('is not offered, rather than shown disabled with a reason nobody can read', async () => {
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (path: string) =>
      path === '/me'
        ? {
            user: { id: 'me', name: 'Pat' },
            features: { projects: true, shareLinks: false, temporaryChat: false },
          }
        : get(path),
    );
    await render('/');
    expect(document.querySelector('[aria-label="Start temporary chat"]')).toBeNull();
    expect(document.querySelector('[title="Temporary chat is unavailable"]')).toBeNull();
  });

  it('is offered to a role with it', async () => {
    await render('/');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Start temporary chat"]');
    expect(button?.disabled).toBe(false);
  });
});
