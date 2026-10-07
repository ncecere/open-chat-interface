// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { fillAuthForm } from './auth-test-utils';

/**
 * Screen readers and the sign-in error (#183): it was a plain paragraph, so
 * it was not announced, and the fields were not marked invalid or tied to it.
 * The real Better Auth client runs against responses shaped as Better Auth
 * (a wrong password) and the API's rate limiter send them.
 */
const network = vi.hoisted(() => {
  const state = { answer: (): Response => new Response(null, { status: 404 }) };
  // Installed before the auth client is created, which keeps the fetch it finds.
  globalThis.fetch = async () => state.answer();
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

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', '/auth/login');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <LoginPage />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function signIn() {
  await fillAuthForm(container);
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}
const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;

it('announces a wrong email or password and marks both fields with it', async () => {
  expect(field('email').getAttribute('aria-invalid')).toBeNull();
  network.answer = () =>
    Response.json(
      { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
      { status: 401 },
    );
  await signIn();

  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe('Unable to sign in. Check your email and password.');
  for (const id of ['email', 'password']) {
    expect(field(id).getAttribute('aria-invalid')).toBe('true');
    expect(field(id).getAttribute('aria-describedby')).toBe(alert.id);
  }
});

it('announces a rate limit without calling the fields invalid', async () => {
  network.answer = () =>
    Response.json(
      {
        message: 'Too many attempts. Wait a minute and try again.',
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' },
      },
      { status: 429 },
    );
  await signIn();

  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe('Too many attempts. Wait a minute and try again.');
  expect(field('email').getAttribute('aria-invalid')).toBeNull();
  expect(field('email').getAttribute('aria-describedby')).toBe(alert.id);
});

it('says in its own words which fields are empty or malformed, not the browser’s bubble (#320)', async () => {
  let asked = 0;
  network.answer = () => {
    asked += 1;
    return new Response(null, { status: 500 });
  };
  // The form opts out of the browser's check, which stopped at the first field.
  expect(container.querySelector('form')!.noValidate).toBe(true);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field('email'), 'not-an-email');
    field('email').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe(
    'Enter an email address such as you@example.com. Enter your password.',
  );
  // Each field is described by its own part of the message (#338).
  const describedBy = (id: string) =>
    document.getElementById(field(id).getAttribute('aria-describedby')!)?.textContent;
  expect(describedBy('email')).toBe('Enter an email address such as you@example.com.');
  expect(describedBy('password')).toBe('Enter your password.');
  for (const id of ['email', 'password']) {
    expect(field(id).getAttribute('aria-invalid')).toBe('true');
  }
  expect(asked).toBe(0);
});
