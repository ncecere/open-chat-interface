// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A session ended while the app is open, by a ban or Sign out everywhere
 * (#165). The page kept its stale sidebar and conversation, sending showed
 * "Authentication required", and Skip for now on the introduction did
 * nothing. The app's real router, API client, Better Auth client and chat
 * request path run here; only the shell and pages are stand-ins, and the
 * network answers 401 as the API does once the session is gone.
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
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: {
      localAuthEnabled: true,
      registrationMode: 'invite_only',
      smtpConfigured: true,
      ssoProviders: [],
      branding: {},
    },
    isLoading: false,
  }),
}));

const network = { signedIn: true };
const unauthorized = () =>
  Response.json(
    { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
    { status: 401 },
  );

let container: HTMLDivElement;
let root: Root;
let router: typeof import('../../src/router')['router'];
let runtime: typeof import('@tanstack/react-router');

beforeEach(async () => {
  vi.resetModules();
  network.signedIn = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url, 'http://localhost:3000').pathname;
      if (path === '/api/auth/sign-out') {
        network.signedIn = false;
        return Response.json({ success: true });
      }
      if (!network.signedIn) return unauthorized();
      if (path === '/api/me') return Response.json({ user: { id: 'u1', role: 'user' } });
      return Response.json({});
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
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
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
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const location = () => router.state.location;

it('goes to sign-in, saying so, when a request finds the session ended', async () => {
  await open('/chat/a');
  expect(container.textContent).toBe('Chat thread a');

  network.signedIn = false;
  // Skip for now on the introduction.
  const { api } = await import('../../src/lib/api-client');
  await act(async () => {
    await api.post('/me/onboarding/skip').catch(() => undefined);
  });
  await settle();
  expect(location().pathname).toBe('/auth/login');
  // Signing in again comes back to the conversation (#225), and the address
  // bar reads `signed-out=1`, not `signed-out=%221%22` (#237).
  expect(location().search).toEqual({ 'signed-out': 1, redirect: '/chat/a' });
  expect(location().href).toBe('/auth/login?signed-out=1&redirect=%2Fchat%2Fa');
  expect(container.querySelector('[data-shell]')).toBeNull();
});

it('does the same when sending a message finds it ended', async () => {
  await open('/chat/a');
  network.signedIn = false;
  const { fetchRetryingDrain } = await import('../../src/lib/chat-retry');
  await act(async () => {
    const response = await fetchRetryingDrain(fetch, '/api/chat', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });
  await settle();
  expect(location().pathname).toBe('/auth/login');
  expect(location().href).toBe('/auth/login?signed-out=1&redirect=%2Fchat%2Fa');
});

it('says nothing to someone who was never signed in', async () => {
  network.signedIn = false;
  await open('/chat/a');
  await settle();
  expect(location().pathname).toBe('/auth/login');
  // No notice, only the way back to the page asked for (#225).
  expect(location().search).toEqual({ redirect: '/chat/a' });
});

it('says nothing after signing out on purpose', async () => {
  await open('/chat/a');
  const { authClient } = await import('../../src/lib/auth-client');
  const { api } = await import('../../src/lib/api-client');
  await act(async () => {
    await authClient.signOut();
    // A query still mounted refetches as the person leaves.
    await api.get('/threads?view=sidebar').catch(() => undefined);
  });
  await settle();
  expect(location().pathname).toBe('/chat/a');
});

it('tells the person on the sign-in page', async () => {
  network.signedIn = false;
  window.history.replaceState(null, '', '/auth/login?signed-out=1');
  await open('/auth/login?signed-out=1');
  await settle();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'You were signed out, from another device or by an administrator. Sign in again to continue.',
  );
});
