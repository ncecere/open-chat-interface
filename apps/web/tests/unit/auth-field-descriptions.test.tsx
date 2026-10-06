// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { ResetPasswordPage } from '../../src/routes/auth/password-reset';
import { SignupPage } from '../../src/routes/auth/signup';

/**
 * #338: the sign-in form's one combined message was the description of both
 * fields, so focusing Email read the password's complaint too; and the new
 * password's own message ("Use at least 12 characters for your password.")
 * was read with the hint ("Use at least 12 characters.") beside it. The real
 * pages; a form's own check refuses before any request, so no network.
 */
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: {
      localAuthEnabled: true,
      registrationMode: 'open',
      smtpConfigured: true,
      ssoProviders: [],
      branding: {},
    },
    isLoading: false,
  }),
}));

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
}
async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
/** What a screen reader reads after a field's name: the texts it is described by. */
function description(id: string): string[] {
  const ids = container.querySelector(`#${id}`)!.getAttribute('aria-describedby') ?? '';
  return ids
    .split(' ')
    .filter(Boolean)
    .map((part) => document.getElementById(part)!.textContent!);
}

describe('sign in', () => {
  it('describes each field by its own message, and announces the alert once', async () => {
    await render('/auth/login', <LoginPage />);
    await type('email', 'not-an-email');
    await submit();
    expect(description('email')).toEqual(['Enter an email address such as you@example.com.']);
    expect(description('password')).toEqual(['Enter your password.']);
    // One alert, with the whole message, as before.
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe(
      'Enter an email address such as you@example.com. Enter your password.',
    );
    expect(container.querySelector('#email')!.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('#password')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('describes only the field at fault when just one is', async () => {
    await render('/auth/login', <LoginPage />);
    await type('email', 'person@example.test');
    await submit();
    expect(description('email')).toEqual([]);
    expect(container.querySelector('#email')!.getAttribute('aria-invalid')).toBeNull();
    expect(description('password')).toEqual(['Enter your password.']);
  });
});

describe('sign up', () => {
  it('describes each field by its own message and does not repeat the length rule', async () => {
    await render('/auth/signup', <SignupPage />);
    await type('signup-password', 'short');
    await submit();
    expect(description('signup-name')).toEqual(['Enter your name.']);
    expect(description('signup-email')).toEqual(['Enter your email address.']);
    expect(description('signup-password')).toEqual([
      'Use at least 12 characters for your password.',
    ]);
  });

  it('keeps the hint for a password nothing has refused', async () => {
    await render('/auth/signup', <SignupPage />);
    expect(description('signup-password')).toEqual(['Use at least 12 characters.']);
  });
});

describe('reset password', () => {
  it('reads the length rule once after a short password', async () => {
    await render('/auth/reset-password?token=abc', <ResetPasswordPage />);
    expect(description('new-password')).toEqual(['Use at least 12 characters.']);
    await type('new-password', 'short');
    await submit();
    expect(description('new-password')).toEqual(['Use at least 12 characters for your password.']);
    expect(container.querySelector('#new-password')!.getAttribute('aria-invalid')).toBe('true');
  });
});
