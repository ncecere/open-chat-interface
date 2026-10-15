// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoFactorPage } from '../../src/routes/auth/two-factor';

/**
 * The second step of sign-in (#399): one code field that takes a paste, a
 * recovery code and a passkey as alternatives, a clear message for every code
 * the API answers with, and a way back. Only the sign-in service is faked.
 */
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
  passkey: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    search?: Record<string, string>;
  }) => (
    <a
      href={`${to}${search && Object.keys(search).length ? `?${new URLSearchParams(search)}` : ''}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({ data: { branding: {} }, isLoading: false, firstLoad: false }),
}));
vi.mock('../../src/lib/auth-client', () => ({
  authClient: {
    twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: mocks.verifyBackupCode },
    signIn: { passkey: mocks.passkey },
  },
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient();
  for (const mock of Object.values(mocks)) mock.mockReset();
  window.history.replaceState(null, '', '/auth/two-factor');
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TwoFactorPage />
      </QueryClientProvider>,
    ),
  );

const input = () => container.querySelector('input') as HTMLInputElement;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? '';
const buttons = () => [...container.querySelectorAll('button')];
const named = (name: string) => buttons().find((button) => button.textContent?.trim() === name);

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
async function verify(value: string) {
  await type(value);
  await submit();
}

describe('the code field (WCAG 2.2 SC 3.3.8)', () => {
  it('is one visible, labelled field a password manager and a paste can fill', async () => {
    await render();
    const field = input();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.hasAttribute('maxlength')).toBe(false);
    expect(field.hasAttribute('onpaste')).toBe(false);
    const label = container.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toBe('Authentication code');
    expect(container.querySelector('h1')?.textContent).toBe('Two-step verification');
  });

  it('is not changed by a paste, and does not submit by itself at six digits', async () => {
    await render();
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    await type('123456');
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
  });
});

describe('verifying', () => {
  it('sends a pasted "123 456" as 123456, without a trust-this-device flag, and goes on', async () => {
    mocks.verifyTotp.mockResolvedValue({ data: { token: 't' }, error: null });
    client.setQueryData(['me'], null);
    await render();
    await verify('123 456');
    expect(mocks.verifyTotp).toHaveBeenCalledTimes(1);
    const [call] = mocks.verifyTotp.mock.calls[0]!;
    expect(call.code).toBe('123456');
    expect(call).not.toHaveProperty('trustDevice');
    // What was cached while signed out must not be handed to the person who just signed in.
    expect(client.getQueryData(['me'])).toBeUndefined();
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
  });

  it('returns to the page the person asked for', async () => {
    mocks.verifyTotp.mockResolvedValue({ data: {}, error: null });
    window.history.replaceState(null, '', '/auth/two-factor?redirect=%2Fadmin%2Faudit');
    await render();
    await verify('654321');
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/admin/audit' });
  });

  it('refuses an empty code in words, marks the field, and puts focus there', async () => {
    await render();
    await submit();
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(alertText()).toBe('Enter the code from your authenticator app.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toContain(
      container.querySelector('[role="alert"]')!.id,
    );
    expect(document.activeElement).toBe(input());
  });
});

describe('every refusal the API documents', () => {
  async function refused(error: Record<string, unknown>, headers?: Record<string, string>) {
    mocks.verifyTotp.mockImplementation(
      async (args: {
        fetchOptions?: { onResponse?: (context: { response: Response }) => void };
      }) => {
        if (headers)
          args.fetchOptions?.onResponse?.({
            response: new Response(null, { status: 429, headers }),
          });
        return { data: null, error };
      },
    );
    await render();
    await verify('111111');
  }

  it('wrong code: says so, keeps the form, marks the field', async () => {
    await refused({ code: 'INVALID_CODE', status: 401, message: 'Invalid code' });
    expect(alertText()).toBe(
      'That code is not right. Check the code in your authenticator app and try again.',
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('already used: says to wait for the next code', async () => {
    await refused({ code: 'CODE_ALREADY_USED', status: 401, message: 'used' });
    expect(alertText()).toContain('Wait for the next code in your authenticator app');
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('an unknown or expired challenge: start again, with no form to retry in', async () => {
    window.history.replaceState(null, '', '/auth/two-factor?redirect=%2Fprojects%2Fp1');
    await refused({ code: 'INVALID_TWO_FACTOR_COOKIE', status: 401, message: 'x' });
    expect(alertText()).toContain('Start again');
    expect(container.querySelector('form')).toBeNull();
    const again = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Start again');
    expect(again?.getAttribute('href')).toBe('/auth/login?redirect=%2Fprojects%2Fp1');
  });

  it('five wrong codes: start again', async () => {
    await refused({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', status: 400, message: 'x' });
    expect(alertText()).toContain('Too many wrong codes');
    expect(container.querySelector('form')).toBeNull();
    expect([...container.querySelectorAll('a')].map((a) => a.textContent)).toContain('Start again');
  });

  it('locked: says it is locked, for how long, and who can help', async () => {
    await refused({ code: 'ACCOUNT_TEMPORARILY_LOCKED', status: 429, message: 'x' });
    expect(alertText()).toContain('locked');
    expect(alertText()).toContain('15 minutes');
    expect(alertText()).toContain('administrator');
  });

  it('rate limited: says how long to wait, from Retry-After', async () => {
    await refused(
      { code: 'TOO_MANY_REQUESTS', status: 429, message: 'x' },
      { 'retry-after': '37' },
    );
    expect(alertText()).toBe('Too many attempts. Try again in 37 seconds.');
  });

  it('does not take an outage for a wrong code', async () => {
    await refused({ status: 502, statusText: 'Bad Gateway' });
    expect(alertText()).toBe('Sign-in is temporarily unavailable. Try again in a moment.');
  });

  it('does not take a connection that failed outright for a wrong code', async () => {
    mocks.verifyTotp.mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    await verify('111111');
    expect(alertText()).toBe('Sign-in is temporarily unavailable. Try again in a moment.');
  });

  it('clears the message once the code is edited', async () => {
    await refused({ code: 'INVALID_CODE', status: 401, message: 'x' });
    await type('2');
    expect(alertText()).toBe('');
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });
});

describe('a recovery code instead', () => {
  async function toRecovery() {
    await render();
    await act(async () => named('Use a recovery code instead')!.click());
  }

  it('swaps the field for a recovery code, the way back, and sends the code trimmed', async () => {
    mocks.verifyBackupCode.mockResolvedValue({ data: {}, error: null });
    await toRecovery();
    expect(container.querySelector('label')?.textContent).toBe('Recovery code');
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().hasAttribute('maxlength')).toBe(false);
    expect(named('Use an authenticator code instead')).toBeDefined();

    await verify('  AbCde-fGh12  ');
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    const [call] = mocks.verifyBackupCode.mock.calls[0]!;
    expect(call.code).toBe('AbCde-fGh12');
    expect(call).not.toHaveProperty('trustDevice');
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/' });
  });

  it('says a wrong recovery code is wrong and that case matters', async () => {
    mocks.verifyBackupCode.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_BACKUP_CODE', status: 401, message: 'x' },
    });
    await toRecovery();
    await verify('aaaaa-bbbbb');
    expect(alertText()).toContain('That recovery code is not right');
  });

  it('says a used recovery code is used', async () => {
    mocks.verifyBackupCode.mockResolvedValue({
      data: null,
      error: { code: 'CODE_ALREADY_USED', status: 401, message: 'x' },
    });
    await toRecovery();
    await verify('aaaaa-bbbbb');
    expect(alertText()).toContain('recovery code was already used');
  });

  it('goes back to the authenticator field, empty and without the old error', async () => {
    mocks.verifyBackupCode.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_BACKUP_CODE', status: 401, message: 'x' },
    });
    await toRecovery();
    await verify('aaaaa-bbbbb');
    await act(async () => named('Use an authenticator code instead')!.click());
    expect(container.querySelector('label')?.textContent).toBe('Authentication code');
    expect(input().value).toBe('');
    expect(alertText()).toBe('');
  });
});

describe('a passkey instead', () => {
  it('is not offered where the browser has no WebAuthn', async () => {
    await render();
    expect(named('Use a passkey instead')).toBeUndefined();
  });

  it('signs in with the passkey, which is both factors, and goes on', async () => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
    mocks.passkey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    window.history.replaceState(null, '', '/auth/two-factor?redirect=%2Fsettings');
    await render();
    await act(async () => named('Use a passkey instead')!.click());
    expect(mocks.passkey).toHaveBeenCalledTimes(1);
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({ href: '/settings' });
  });

  it('says calmly that it was cancelled, and leaves the code field to use', async () => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
    mocks.passkey.mockResolvedValue({
      data: null,
      error: { code: 'AUTH_CANCELLED', status: 400, message: 'auth cancelled' },
    });
    await render();
    await act(async () => named('Use a passkey instead')!.click());
    expect(container.textContent).toContain('The passkey request was cancelled or timed out.');
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });
});

describe('the way back', () => {
  it('links back to sign-in, keeping the page the person asked for', async () => {
    window.history.replaceState(null, '', '/auth/two-factor?redirect=%2Fadmin%2Fusers');
    await render();
    const back = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Back to sign in',
    );
    expect(back?.getAttribute('href')).toBe('/auth/login?redirect=%2Fadmin%2Fusers');
  });
});
