// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * An expired or damaged email-verification link says what happened and how
 * to get a new one (#329). Better Auth sends it back to the link's callback,
 * `/?error=TOKEN_EXPIRED` (or INVALID_TOKEN), and the app's guard took a
 * signed-out visitor on to the plain sign-in form, the code buried in
 * `?redirect=`. The app's real router and page run here; only the chat
 * shell is a stand-in, and the network answers as the API does.
 */
vi.mock('../../src/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-shell>{children}</div>,
}));
vi.mock('../../src/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/routes/chat/home', () => ({ ChatHomePage: () => <h1>Chat home</h1> }));

const network = { signedIn: false, verificationRequests: [] as unknown[] };

let container: HTMLDivElement;
let root: Root;
let router: typeof import('../../src/router')['router'];
let runtime: typeof import('@tanstack/react-router');

beforeEach(async () => {
  vi.resetModules();
  network.signedIn = false;
  network.verificationRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url, 'http://localhost:3000').pathname;
      if (path === '/api/auth/status')
        return Response.json({
          localAuthEnabled: true,
          registrationMode: 'invite_only',
          emailVerificationRequired: true,
          smtpConfigured: true,
          ssoProviders: [],
          branding: { appName: 'Fix7' },
        });
      if (path === '/api/auth/send-verification-email') {
        network.verificationRequests.push(await request.json());
        return Response.json({ status: true });
      }
      if (path === '/api/me')
        return network.signedIn
          ? Response.json({ user: { id: 'u1', role: 'user' } })
          : Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
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
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}
const heading = () => container.querySelector('h1')?.textContent;

it('says an expired link has expired, and how to get a new one', async () => {
  await open('/?error=TOKEN_EXPIRED&callbackURL=%2F');
  expect(router.state.location.pathname).toBe('/auth/verify-email');
  expect(heading()).toBe('Verification link expired');
  expect(container.textContent).toContain('each link works for 1 hour');
  expect(container.textContent).toContain('Sign in with your email and password');
  expect(container.querySelector('a[href="/auth/login"]')?.textContent).toBe('Sign in');

  // A new link can be asked for right here.
  const input = container.querySelector<HTMLInputElement>('#verify-email-address')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, 'late@example.test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const resend = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Resend verification email',
  )!;
  await act(async () => resend.click());
  expect(network.verificationRequests).toEqual([{ email: 'late@example.test', callbackURL: '/' }]);
});

it('says a damaged link does not work, even for someone signed in', async () => {
  network.signedIn = true;
  await open('/?error=INVALID_TOKEN');
  expect(router.state.location.pathname).toBe('/auth/verify-email');
  expect(heading()).toBe('Verification link unavailable');
  expect(container.textContent).toContain('This verification link does not work.');
});

it('leaves the home page alone otherwise', async () => {
  network.signedIn = true;
  await open('/?error=SOMETHING_ELSE');
  expect(router.state.location.pathname).toBe('/');
  expect(heading()).toBe('Chat home');
});
