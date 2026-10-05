// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { SignupPage } from '../../src/routes/auth/signup';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signup: vi.fn(),
  signin: vi.fn(),
  sso: vi.fn(),
  required: false,
  ssoProviders: [] as { providerId: string; label: string; autoRedirect: boolean }[],
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: {
      localAuthEnabled: true,
      registrationMode: 'open',
      emailVerificationRequired: mocks.required,
      smtpConfigured: true,
      ssoProviders: mocks.ssoProviders,
      branding: {},
    },
    isLoading: false,
  }),
}));
vi.mock('../../src/lib/auth-client', () => ({
  authClient: {
    signUp: { email: mocks.signup },
    signIn: { email: mocks.signin, sso: mocks.sso },
  },
}));
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const withClient = (ui: ReactNode) => (
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>
);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  root = createRoot(container);
  client = new QueryClient();
  mocks.navigate.mockReset();
  mocks.signup.mockReset();
  mocks.signin.mockReset();
  mocks.required = false;
  mocks.sso.mockReset();
  mocks.ssoProviders = [];
  window.history.replaceState(null, '', '/auth/login');
});
afterEach(async () => {
  await act(() => root.unmount());
});
async function submit() {
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

it('uses the signup response rather than stale disabled-verification bootstrap data', async () => {
  mocks.signup.mockResolvedValue({ data: { token: null }, error: null });
  await act(() => root.render(withClient(<SignupPage />)));
  await submit();
  expect(container.textContent).toContain('Check your email');
  expect(container.textContent).toContain('Resend verification email');
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('navigates after a real signup session even if cached bootstrap still requires verification', async () => {
  mocks.required = true;
  mocks.signup.mockResolvedValue({ data: { token: 'test-session' }, error: null });
  await act(() => root.render(withClient(<SignupPage />)));
  await submit();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
});

it('offers resend when sign-in is refused for an unverified account', async () => {
  mocks.signin.mockResolvedValue({
    error: { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address before signing in' },
  });
  await act(() => root.render(withClient(<LoginPage />)));
  await submit();
  expect(container.textContent).toContain('Resend verification email');
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('words a wrong email or password as the user guide does (#97)', async () => {
  mocks.signin.mockResolvedValue({
    error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
  });
  await act(() => root.render(withClient(<LoginPage />)));
  await submit();
  expect(container.textContent).toContain('Unable to sign in. Check your email and password.');
  expect(container.textContent).not.toContain('Invalid email or password');
});

it('drops what was cached while signed out before entering the app', async () => {
  // Signing out refetches /me while the app is still mounted, caching an
  // anonymous answer; the next account must not inherit it (or the previous
  // account's projects).
  client.setQueryData(['me'], null);
  client.setQueryData(['projects', 'sidebar'], { projects: [{ id: 'old' }] });
  mocks.signin.mockResolvedValue({ data: { user: { id: 'next' } }, error: null });
  await act(() => root.render(withClient(<LoginPage />)));
  await submit();

  expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
  expect(client.getQueryData(['me'])).toBeUndefined();
  expect(client.getQueryData(['projects', 'sidebar'])).toBeUndefined();
});

it('asks the SSO plugin to bring a refused sign-in back to this page', async () => {
  mocks.ssoProviders = [{ providerId: 'campus', label: 'Campus SSO', autoRedirect: false }];
  mocks.sso.mockResolvedValue({ data: { url: 'https://idp.example.test' }, error: null });
  await act(() => root.render(withClient(<LoginPage />)));
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Continue with Campus SSO'),
  );
  await act(async () => button?.click());
  // Without an error URL a refusal went to "/", whose guard redirected here
  // and dropped the reason.
  expect(mocks.sso).toHaveBeenCalledWith({
    providerId: 'campus',
    callbackURL: '/',
    errorCallbackURL: '/auth/login',
  });
});

it('explains a sign-in refused because the provider may not link to an existing account', async () => {
  window.history.replaceState(null, '', '/auth/login?error=unable+to+link+account');
  await act(() => root.render(withClient(<LoginPage />)));
  expect(container.textContent).toContain('An account with this email address already exists');
});
