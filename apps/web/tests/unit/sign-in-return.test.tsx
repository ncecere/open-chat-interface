// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeReturnPath } from '../../src/lib/return-path';
import { LoginPage } from '../../src/routes/auth/login';

/**
 * #225: signing in from a link to /admin/webhooks always landed on the chat
 * home. Sign-in returns to the page asked for, and only to a path on this
 * site. The real page and Better Auth client against a fetch answering as
 * the API does; the router's navigate is recorded.
 */
const mocks = vi.hoisted(() => {
  const state = { navigate: vi.fn(), answer: (): Response => new Response(null, { status: 404 }) };
  // Installed before the auth client is created, which keeps the fetch it finds.
  globalThis.fetch = async () => state.answer();
  return state;
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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

describe('safeReturnPath', () => {
  it.each([
    ['/admin/webhooks', '/admin/webhooks'],
    ['/chat/t1?message=m2#end', '/chat/t1?message=m2#end'],
    ['/settings/../admin/users', '/admin/users'],
  ])('keeps a path on this site: %s', (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    'https://evil.example/admin',
    '//evil.example/admin',
    '/\\evil.example',
    '\\\\evil.example',
    '/\tevil',
    'javascript:alert(1)',
    'admin/webhooks',
    '/auth/login?redirect=/admin',
    '/api/me/export',
    '',
    null,
  ])('refuses %s', (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.navigate.mockReset();
  mocks.answer = () =>
    Response.json({ token: 't', user: { id: 'u1', email: 'a@example.test', name: 'A' } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function signInAt(path: string) {
  window.history.replaceState(null, '', path);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <LoginPage />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

describe('signing in', () => {
  it('returns to the page asked for', async () => {
    await signInAt('/auth/login?redirect=%2Fadmin%2Fwebhooks');
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/admin/webhooks' });
  });

  it('goes to the home page without one', async () => {
    await signInAt('/auth/login');
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
  });

  it.each(['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example'])(
    'goes to the home page, not off the site, for redirect=%s',
    async (target) => {
      await signInAt(`/auth/login?redirect=${target}`);
      expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
    },
  );
});
