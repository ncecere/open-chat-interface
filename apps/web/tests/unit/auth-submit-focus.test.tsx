// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { ForgotPasswordPage, ResetPasswordPage } from '../../src/routes/auth/password-reset';
import { fillAuthForm } from './auth-test-utils';

/**
 * #190: after submitting sign-in, Forgot password or a reset, focus fell to
 * the body (the submit button is disabled while the request runs, and the
 * outcome replaces the form), so a screen reader said nothing. The real
 * pages and Better Auth client, against responses shaped as the API sends.
 */
const network = vi.hoisted(() => {
  const state = {
    answer: (_path: string): Response => new Response(null, { status: 404 }),
  };
  // Installed before the auth client is created, which keeps the fetch it finds.
  globalThis.fetch = async (input) => {
    // A round trip: the form shows its pending state (a disabled button) meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    return state.answer(url.pathname);
  };
  return state;
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
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

const OFF = { active: false, source: null, reason: null, until: null, window: null };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(path: string, page: ReactNode) {
  window.history.replaceState(null, '', path);
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
}

/** Types into `id`, then presses the form's submit button from the keyboard. */
async function submit(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.focus();
  // A focused control that is disabled loses focus to the body in browsers
  // (the focus fixup rule); happy-dom keeps it, and will not blur a disabled
  // control, so that is done here.
  const fixup = new MutationObserver(() => {
    if (!button.disabled || document.activeElement !== button) return;
    button.disabled = false;
    button.blur();
    button.disabled = true;
  });
  fixup.observe(button, { attributes: true, attributeFilter: ['disabled'] });
  await fillAuthForm(container);
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  fixup.disconnect();
}

const focused = () => document.activeElement as HTMLElement;

describe('sign in', () => {
  it('moves focus to the email field, which the error describes, after wrong credentials', async () => {
    network.answer = () =>
      Response.json(
        { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
        { status: 401 },
      );
    await render('/auth/login', <LoginPage />);
    await submit('email', 'm.bell@example.test');
    expect(focused().id).toBe('email');
    expect(focused().getAttribute('aria-invalid')).toBe('true');
    expect(focused().getAttribute('aria-describedby')).toBe('login-error');
  });

  it('returns focus to Sign in after a refusal that is not about the fields', async () => {
    network.answer = () =>
      Response.json(
        { message: 'Too many attempts.', error: { code: 'RATE_LIMITED' } },
        { status: 429 },
      );
    await render('/auth/login', <LoginPage />);
    await submit('email', 'm.bell@example.test');
    expect(focused().textContent).toContain('Sign in');
    expect(focused().getAttribute('type')).toBe('submit');
  });
});

describe('forgot password', () => {
  it('focuses "Check your email", read with its message', async () => {
    network.answer = (path) =>
      path === '/api/maintenance' ? Response.json(OFF) : Response.json({ status: true });
    await render('/auth/forgot-password', <ForgotPasswordPage />);
    await submit('reset-email', 'm.bell@example.test');
    expect(focused().tagName).toBe('H1');
    expect(focused().textContent).toBe('Check your email');
    const message = document.getElementById(focused().getAttribute('aria-describedby')!);
    expect(message?.textContent).toContain('If an account uses this address');
  });

  it('starts as usual when opened: nothing is focused before a submit', async () => {
    network.answer = () => Response.json(OFF);
    await render('/auth/forgot-password', <ForgotPasswordPage />);
    expect(focused()).toBe(document.body);
  });
});

describe('reset password', () => {
  it('focuses "Reset link unavailable", read with its reason, when the token is refused', async () => {
    network.answer = () =>
      Response.json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, { status: 400 });
    await render('/auth/reset-password?token=expired', <ResetPasswordPage />);
    await submit('new-password', 'a long enough password');
    expect(focused().tagName).toBe('H1');
    expect(focused().textContent).toBe('Reset link unavailable');
    const message = document.getElementById(focused().getAttribute('aria-describedby')!);
    expect(message?.textContent).toBe('This reset link is invalid or has expired.');
  });

  it('focuses "Password updated" after a reset', async () => {
    network.answer = () => Response.json({ status: true });
    await render('/auth/reset-password?token=good', <ResetPasswordPage />);
    await submit('new-password', 'a long enough password');
    expect(focused().textContent).toBe('Password updated');
  });
});
