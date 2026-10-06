// @vitest-environment happy-dom
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
import { AppShell } from '../../src/components/layout/app-shell';
import { isApplePlatform } from '../../src/lib/keyboard-shortcuts';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { ChatHomePage } from '../../src/routes/chat/home';
import { button, settle } from './admin-test-utils';

/**
 * #251: starting a new chat (⌘⇧O, New Chat, the palette) left focus on the
 * body or the button, so typing went nowhere. #242: choosing a conversation
 * in the phone drawer hid the focused link with the drawer and focus fell to
 * the body.
 *
 * The real shell, sidebar, router and home page; only the server is a stub.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const thread = (id: string, title: string) => ({
  id,
  title,
  pinned: false,
  archived: false,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId: null,
  lastMessageAt: '2026-10-05T10:00:00.000Z',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
});

const MODEL = {
  id: 'm1',
  slug: 'alpha',
  displayName: 'Alpha',
  description: null,
  providerId: 'p1',
  providerKind: 'openai-compatible',
  providerLabel: 'Gateway',
  upstreamModelId: 'alpha',
  capabilities: [],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

let root: Root | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'me', name: 'Pat Nair', email: 'pat@example.test', role: 'user' },
        preferences: {},
        features: { temporaryChat: true, projects: false, attachments: true, webSearch: false },
      };
    if (path === '/models') return { models: [MODEL] };
    if (path === '/me/broadcasts') return { broadcasts: [] };
    if (path === '/maintenance') return { active: false };
    if (path.startsWith('/threads'))
      return { threads: [thread('t1', 'Budget notes'), thread('t2', 'Trip plan')] };
    return { threads: [], projects: [], branding: {} };
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A desktop (docked sidebar, mouse and keyboard), a phone-width window, or a touch phone. */
function device(kind: 'desktop' | 'narrow' | 'touch') {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches:
          query === '(min-width: 1024px)'
            ? kind === 'desktop'
            : query.includes('pointer: coarse')
              ? kind === 'touch'
              : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

/** The app's shell around a home page and a conversation page. */
async function renderApp(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </ThemeProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <ChatHomePage />,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/chat/$threadId',
        component: () => <textarea aria-label="Message input" />,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => router.load());
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await frames();
  return router;
}

/** Commits, queries and a few animation frames. */
async function frames() {
  await settle();
  await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
  await settle();
}

const composer = () => document.querySelector<HTMLTextAreaElement>('textarea')!;

describe('a new chat takes the cursor (#251)', () => {
  it('after ⌘⇧O from a conversation', async () => {
    device('desktop');
    const router = await renderApp('/chat/t1');
    button('New Chat').focus();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'O',
          shiftKey: true,
          metaKey: isApplePlatform(),
          ctrlKey: !isApplePlatform(),
        }),
      );
    });
    await frames();
    expect(router.state.location.pathname).toBe('/');
    expect(document.activeElement).toBe(composer());
    expect(composer().placeholder).toBe('Type your message here...');
  });

  it('after New Chat, also on the home page already', async () => {
    device('desktop');
    await renderApp('/');
    const newChat = button('New Chat');
    newChat.focus();
    await act(async () => newChat.click());
    await frames();
    expect(document.activeElement).toBe(composer());
  });

  it("after the palette's New chat, once the palette has closed", async () => {
    device('narrow');
    const router = await renderApp('/chat/t1');
    const search = button('Search commands and threads');
    search.focus();
    await act(async () => search.click());
    await frames();
    const option = document.getElementById('oci-command-palette-option-new-chat')!;
    await act(async () => option.click());
    await frames();
    expect(router.state.location.pathname).toBe('/');
    expect(document.getElementById('oci-command-palette-option-new-chat')).toBeNull();
    expect(document.activeElement).toBe(composer());
  });

  it('on opening the home page', async () => {
    device('desktop');
    await renderApp('/');
    expect(document.activeElement).toBe(composer());
  });

  it('on a fresh load, once the page waiting for announcements is shown', async () => {
    device('desktop');
    // The page stays invisible until announcements arrive (#167), and an
    // invisible element cannot take focus: as the browser does, here.
    let answer!: (value: unknown) => void;
    const get = api.get.getMockImplementation()!;
    api.get.mockImplementation((path: string) =>
      path === '/me/broadcasts' ? new Promise((resolve) => (answer = resolve)) : get(path),
    );
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, o) {
      if (!this.closest('.invisible')) focus.call(this, o);
    });
    await renderApp('/');
    expect(document.getElementById('main-content')?.className).toContain('invisible');
    expect(document.activeElement).not.toBe(composer());
    await act(async () => answer({ broadcasts: [] }));
    await frames();
    expect(document.activeElement).toBe(composer());
  });

  it('not on a touch phone, where it would open the keyboard', async () => {
    device('touch');
    await renderApp('/');
    expect(document.activeElement).not.toBe(composer());
  });
});

describe('the phone drawer (#242)', () => {
  it('moves focus to the chosen conversation, not the body', async () => {
    device('touch');
    const router = await renderApp('/chat/t1');
    await act(async () => button('Open sidebar').click());
    await frames();
    const link = [...document.querySelectorAll<HTMLAnchorElement>('aside a')].find((candidate) =>
      candidate.textContent?.includes('Trip plan'),
    )!;
    link.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => link.click());
    await frames();
    expect(router.state.location.pathname).toBe('/chat/t2');
    expect(document.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  it('keeps focus on the page after New Chat on a touch phone, and Close returns it', async () => {
    device('touch');
    await renderApp('/chat/t1');
    await act(async () => button('Open sidebar').click());
    await frames();
    const newChat = [...document.querySelectorAll<HTMLButtonElement>('aside button')]
      .filter((candidate) => candidate.textContent === 'New Chat')
      .at(-1)!;
    newChat.focus();
    await act(async () => newChat.click());
    await frames();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('aside')).toBeNull();

    await act(async () => button('Open sidebar').click());
    await frames();
    const close = button('Close sidebar');
    expect(document.activeElement).toBe(close);
    await act(async () => close.click());
    await frames();
    expect(document.activeElement).toBe(button('Open sidebar'));
  });

  it('puts the cursor in the new chat after New Chat in a narrow window', async () => {
    device('narrow');
    await renderApp('/chat/t1');
    await act(async () => button('Open sidebar').click());
    await frames();
    // The drawer's own New Chat, at its foot (the docked one is hidden below 1024 px).
    const newChat = [...document.querySelectorAll<HTMLButtonElement>('aside button')]
      .filter((candidate) => candidate.textContent === 'New Chat')
      .at(-1)!;
    newChat.focus();
    await act(async () => newChat.click());
    await frames();
    expect(document.activeElement).toBe(composer());
  });
});
