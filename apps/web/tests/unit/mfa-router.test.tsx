// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Where the router puts a person under the two-step requirement (#399): a
 * limited session goes to the setup page from the shell, settings and
 * administration, the setup page is for nobody else, and the second step is a
 * public page. The real router runs; the shell, the gates and the pages are
 * stand-ins, and the network answers as /api/me does.
 */
vi.mock('../../src/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-shell>{children}</div>,
}));
vi.mock('../../src/components/mfa/mfa-gate', () => ({
  MfaGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/components/settings/settings-layout', () => ({
  SettingsLayout: () => <h1>Settings</h1>,
}));
vi.mock('../../src/components/admin/admin-layout', () => ({
  AdminLayout: () => <h1>Administration</h1>,
}));
vi.mock('../../src/routes/chat/home', () => ({ ChatHomePage: () => <h1>Chat home</h1> }));
vi.mock('../../src/routes/chat/thread', () => ({
  ChatThreadPage: ({ threadId }: { threadId: string }) => <h1>Chat thread {threadId}</h1>,
}));
vi.mock('../../src/routes/auth/login', () => ({ LoginPage: () => <h1>Log in</h1> }));
vi.mock('../../src/routes/auth/two-factor', () => ({
  TwoFactorPage: () => <h1>Second step</h1>,
}));
vi.mock('../../src/routes/auth/mfa-setup', () => ({ MfaSetupPage: () => <h1>Set up</h1> }));

const session = {
  signedIn: true,
  role: 'user',
  mfa: undefined as undefined | { limited: boolean },
};

let container: HTMLDivElement;
let root: Root;
let router: typeof import('../../src/router')['router'];
let runtime: typeof import('@tanstack/react-router');

beforeEach(async () => {
  vi.resetModules();
  Object.assign(session, { signedIn: true, role: 'user', mfa: undefined });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path !== '/api/me') return new Response(null, { status: 404 });
      if (!session.signedIn)
        return Response.json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, { status: 401 });
      return Response.json({
        user: { id: 'u1', role: session.role },
        ...(session.mfa ? { mfa: session.mfa } : {}),
      });
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
  await act(async () => root.render(<RouterProvider router={router} />));
}
const where = () => router.state.location.pathname;

it('lets a person who is not limited into the app', async () => {
  session.mfa = { limited: false };
  await open('/chat/a');
  expect(where()).toBe('/chat/a');
  expect(container.textContent).toBe('Chat thread a');
});

it('lets a person with an API that has no two-step verification into the app', async () => {
  await open('/chat/a');
  expect(where()).toBe('/chat/a');
});

it('sends a limited person from the app to the setup page, which is outside the shell', async () => {
  session.mfa = { limited: true };
  await open('/chat/a');
  expect(where()).toBe('/auth/mfa-setup');
  expect(container.textContent).toBe('Set up');
  expect(container.querySelector('[data-shell]')).toBeNull();
});

it('sends a limited person from settings to the setup page', async () => {
  session.mfa = { limited: true };
  await open('/settings');
  expect(where()).toBe('/auth/mfa-setup');
});

it('sends a limited administrator from administration to the setup page', async () => {
  session.role = 'admin';
  session.mfa = { limited: true };
  await open('/admin/users');
  expect(where()).toBe('/auth/mfa-setup');
});

it('shows the setup page to a limited person', async () => {
  session.mfa = { limited: true };
  await open('/auth/mfa-setup');
  expect(where()).toBe('/auth/mfa-setup');
  expect(container.textContent).toBe('Set up');
});

it('sends anyone else away from the setup page', async () => {
  session.mfa = { limited: false };
  await open('/auth/mfa-setup');
  expect(where()).toBe('/');
});

it('sends somebody signed out from the setup page to sign-in', async () => {
  session.signedIn = false;
  await open('/auth/mfa-setup');
  expect(where()).toBe('/auth/login');
});

it('shows the second step to somebody who is not signed in yet', async () => {
  session.signedIn = false;
  await open('/auth/two-factor?redirect=%2Fadmin%2Fusers');
  expect(where()).toBe('/auth/two-factor');
  expect(container.textContent).toBe('Second step');
});

it('takes somebody who is already signed in on from the second step to where they were going', async () => {
  session.mfa = { limited: false };
  await open('/auth/two-factor?redirect=%2Fchat%2Fb');
  expect(where()).toBe('/chat/b');
});

it('moves a person to the setup page when a request is refused while the app is open', async () => {
  session.mfa = { limited: false };
  await open('/chat/a');
  // The requirement started with no grace: the session is limited now.
  session.mfa = { limited: true };
  const { noteMfaRequired } = await import('../../src/lib/mfa-required');
  await act(async () => noteMfaRequired());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(where()).toBe('/auth/mfa-setup');
});

it('leaves the sign-in pages where they are when a request is refused', async () => {
  session.signedIn = false;
  await open('/auth/login');
  const { noteMfaRequired } = await import('../../src/lib/mfa-required');
  await act(async () => noteMfaRequired());
  expect(where()).toBe('/auth/login');
});
