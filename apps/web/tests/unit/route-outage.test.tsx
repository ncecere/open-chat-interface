// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A few seconds of database outage while moving around the app (#164). Every
 * navigation re-checks the session (GET /api/me), which answered 500, and the
 * whole app was replaced by "Could not load this page" until a reload. The
 * app's real router and API client run here; only the shell and the pages
 * are stand-ins, and the network answers as the API did during the outage.
 */
vi.mock('../../src/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-shell>{children}</div>,
}));
vi.mock('../../src/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/routes/chat/home', () => ({ ChatHomePage: () => <h1>Chat home</h1> }));
vi.mock('../../src/routes/chat/thread', () => ({
  ChatThreadPage: ({ threadId }: { threadId: string }) => <h1>Chat thread {threadId}</h1>,
}));
vi.mock('../../src/routes/auth/login', () => ({ LoginPage: () => <h1>Log in</h1> }));

const api = { down: false, signedIn: true, calls: 0 };
const outage = () =>
  Response.json(
    { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    { status: 500 },
  );

let container: HTMLDivElement;
let root: Root;
let router: typeof import('../../src/router')['router'];
let runtime: typeof import('@tanstack/react-router');

beforeEach(async () => {
  vi.resetModules();
  Object.assign(api, { down: false, signedIn: true, calls: 0 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path !== '/api/me') return new Response(null, { status: 404 });
      api.calls += 1;
      if (api.down) return outage();
      if (!api.signedIn)
        return Response.json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, { status: 401 });
      return Response.json({ user: { id: 'u1', role: 'user' } });
    }),
  );
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime = await import('@tanstack/react-router');
  router = (await import('../../src/router')).router;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(path: string) {
  router.update({
    history: runtime.createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  await act(async () => {
    await router.load();
  });
  const { RouterProvider } = runtime;
  await act(async () => root.render(<RouterProvider router={router} />));
}
async function go(to: string) {
  await act(async () => {
    await router.navigate({ to });
  });
}
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null;

it('keeps the app when the session check fails during an outage', async () => {
  await open('/chat/a');
  expect(container.textContent).toBe('Chat thread a');

  api.down = true;
  await go('/chat/b');
  expect(api.calls).toBe(2);
  expect(alert()).toBeNull();
  expect(container.querySelector('[data-shell]')?.textContent).toBe('Chat thread b');
});

it('still signs out when the session has ended', async () => {
  await open('/chat/a');
  api.signedIn = false;
  await go('/chat/b');
  expect(router.state.location.pathname).toBe('/auth/login');
  expect(container.textContent).toBe('Log in');
});

it('loads by itself once the outage is over, when the first load met it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { ROUTE_RETRY_MS } = await import('../../src/components/ui/route-load-error');
  api.down = true;
  await open('/chat/a');
  // Nothing confirmed yet, so there is no app to keep.
  expect(alert()).toContain('Could not load this page');

  api.down = false;
  await act(async () => {
    vi.advanceTimersByTime(ROUTE_RETRY_MS);
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(alert()).toBeNull();
  expect(container.textContent).toBe('Chat thread a');
});
