// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { fillAuthForm } from './auth-test-utils';

/**
 * Sign-in with two-step verification (#399): a password step that answers
 * `twoFactorRedirect` goes to the second step instead of into the app, and the
 * page offers a passkey where the browser has WebAuthn.
 */
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signin: vi.fn(),
  passkey: vi.fn(),
  sso: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: {
      localAuthEnabled: true,
      registrationMode: 'closed',
      emailVerificationRequired: false,
      smtpConfigured: true,
      ssoProviders: [],
      branding: {},
    },
    isLoading: false,
    firstLoad: false,
  }),
}));
vi.mock('../../src/lib/auth-client', () => ({
  authClient: { signIn: { email: mocks.signin, passkey: mocks.passkey, sso: mocks.sso } },
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let conditional: boolean;

const webAuthn = (supported: boolean) => {
  if (!supported) {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    return;
  }
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = Object.assign(
    function PublicKeyCredential() {},
    { isConditionalMediationAvailable: async () => conditional },
  );
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient();
  for (const mock of Object.values(mocks)) mock.mockReset();
  conditional = false;
  webAuthn(false);
  window.history.replaceState(null, '', '/auth/login');
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  webAuthn(false);
});

const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LoginPage />
      </QueryClientProvider>,
    ),
  );
async function submit() {
  await fillAuthForm(container);
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
const passkeyButton = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use a passkey');

describe('the password step of a person with a second step', () => {
  it('goes to the second step, not into the app, and keeps no session in the cache', async () => {
    mocks.signin.mockResolvedValue({
      data: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      error: null,
    });
    client.setQueryData(['marker'], 1);
    await render();
    await submit();
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/auth/two-factor', search: {} });
    // Nothing was signed in, so nothing is dropped from the cache either.
    expect(client.getQueryData(['marker'])).toBe(1);
  });

  it('takes the page the person asked for to the second step', async () => {
    mocks.signin.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    window.history.replaceState(null, '', '/auth/login?redirect=%2Fadmin%2Fusers');
    await render();
    await submit();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/auth/two-factor',
      search: { redirect: '/admin/users' },
    });
  });

  it('still goes straight into the app for a person with no second step', async () => {
    mocks.signin.mockResolvedValue({ data: { token: 't', user: {} }, error: null });
    await render();
    await submit();
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
  });
});

describe('Use a passkey', () => {
  it('is not shown where the browser has no WebAuthn', async () => {
    await render();
    expect(passkeyButton()).toBeUndefined();
    expect(container.querySelector('#email')?.getAttribute('autocomplete')).toBe('email');
  });

  it('signs in and goes to the page asked for, with no password and no code', async () => {
    webAuthn(true);
    mocks.passkey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    window.history.replaceState(null, '', '/auth/login?redirect=%2Fprojects%2Fp1');
    client.setQueryData(['me'], null);
    await render();
    await act(async () => passkeyButton()!.click());
    expect(mocks.passkey).toHaveBeenCalledTimes(1);
    expect(mocks.signin).not.toHaveBeenCalled();
    expect(client.getQueryData(['me'])).toBeUndefined();
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/projects/p1' });
  });

  it('says calmly that it was cancelled and leaves the form to use', async () => {
    webAuthn(true);
    mocks.passkey.mockResolvedValue({
      data: null,
      error: { code: 'AUTH_CANCELLED', status: 400, message: 'auth cancelled' },
    });
    await render();
    await act(async () => passkeyButton()!.click());
    const status = container.querySelector('#passkey-sign-in-message');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe(
      'The passkey request was cancelled or timed out. Try again, or sign in another way.',
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(passkeyButton()?.getAttribute('aria-describedby')).toBe('passkey-sign-in-message');
  });

  it("announces a refusal as an alert with the server's reason", async () => {
    webAuthn(true);
    mocks.passkey.mockResolvedValue({
      data: null,
      error: { code: 'BANNED_USER', status: 403, message: 'You have been banned from this site.' },
    });
    await render();
    await act(async () => passkeyButton()!.click());
    const alert = container.querySelector('#passkey-sign-in-message');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe('You have been banned from this site.');
  });

  it('does not take an outage for a wrong passkey', async () => {
    webAuthn(true);
    mocks.passkey.mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    await act(async () => passkeyButton()!.click());
    expect(container.querySelector('#passkey-sign-in-message')?.textContent).toBe(
      'Sign-in is temporarily unavailable. Try again in a moment.',
    );
  });
});

describe('the browser offering a passkey in the email field (conditional UI)', () => {
  it('is not started where the browser cannot do it', async () => {
    webAuthn(true);
    conditional = false;
    await render();
    expect(mocks.passkey).not.toHaveBeenCalled();
    expect(container.querySelector('#email')?.getAttribute('autocomplete')).toBe('email');
  });

  it('starts, marks the email field for it, and signs in when a passkey is chosen', async () => {
    webAuthn(true);
    conditional = true;
    mocks.passkey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    await render();
    expect(mocks.passkey).toHaveBeenCalledWith({ autoFill: true });
    expect(container.querySelector('#email')?.getAttribute('autocomplete')).toBe('email webauthn');
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
  });

  it('says nothing when the button replaces the pending request', async () => {
    webAuthn(true);
    conditional = true;
    mocks.passkey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_CEREMONY_ABORTED', status: 400, message: 'auth cancelled' },
    });
    await render();
    expect(container.querySelector('[role="alert"], #passkey-sign-in-message')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
