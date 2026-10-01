// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { SignupPage } from '../../src/routes/auth/signup';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signup: vi.fn(),
  signin: vi.fn(),
  required: false,
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
      ssoProviders: [],
      branding: {},
    },
    isLoading: false,
  }),
}));
vi.mock('../../src/lib/auth-client', () => ({
  authClient: {
    signUp: { email: mocks.signup },
    signIn: { email: mocks.signin },
  },
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  root = createRoot(container);
  mocks.navigate.mockReset();
  mocks.signup.mockReset();
  mocks.signin.mockReset();
  mocks.required = false;
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
  await act(() => root.render(<SignupPage />));
  await submit();
  expect(container.textContent).toContain('Check your email');
  expect(container.textContent).toContain('Resend verification email');
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('navigates after a real signup session even if cached bootstrap still requires verification', async () => {
  mocks.required = true;
  mocks.signup.mockResolvedValue({ data: { token: 'test-session' }, error: null });
  await act(() => root.render(<SignupPage />));
  await submit();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
});

it('offers resend when sign-in is refused for an unverified account', async () => {
  mocks.signin.mockResolvedValue({
    error: { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address before signing in' },
  });
  await act(() => root.render(<LoginPage />));
  await submit();
  expect(container.textContent).toContain('Resend verification email');
  expect(mocks.navigate).not.toHaveBeenCalled();
});
