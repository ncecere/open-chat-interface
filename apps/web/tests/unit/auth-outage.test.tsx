// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from '../../src/routes/auth/login';
import { ForgotPasswordPage, ResetPasswordPage } from '../../src/routes/auth/password-reset';

/**
 * The sign-in and password-reset pages during an outage (#288). With the
 * database stopped, signing in with the right password said "Check your email
 * and password", and Forgot password said resets were not offered and to
 * contact an administrator. The real Better Auth client, the real status
 * query and a real QueryClient run here, against a fetch that answers as the
 * API does: `outage()` is the response apps/api's auth-outage tests get from
 * the real auth handler with the database unreachable.
 */
const network = vi.hoisted(() => {
  const state = {
    handler: (async () => new Response(null, { status: 404 })) as (
      path: string,
    ) => Promise<Response>,
  };
  // Installed before the auth client is created, which keeps the fetch it finds.
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    return state.handler(url.pathname);
  };
  return state;
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

/** The API with its database unreachable (middleware/error-handler.ts). */
const outage = () =>
  Response.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'The connection to the database was interrupted. Try again; if you were saving something, check whether it was saved first.',
        retryable: true,
      },
    },
    { status: 500, headers: { 'X-OCI-Retryable': 'database-connection', 'Retry-After': '1' } },
  );
/** The bundled proxy with the API itself down. */
const badGateway = () => new Response(null, { status: 502 });
/** Better Auth's refusal of a wrong password. */
const wrongPassword = () =>
  Response.json(
    { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' },
    { status: 401 },
  );
const STATUS = {
  registrationMode: 'invite_only',
  emailVerificationRequired: false,
  smtpConfigured: true,
  localAuthEnabled: true,
  ssoProviders: [],
  branding: {},
};
const OFF = { active: false, source: null, reason: null, until: null, window: null };

/** Answers each path with its handler; the status and read-only state load unless overridden. */
function serve(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  network.handler = async (path) => {
    calls.push(path);
    const route =
      routes[path] ??
      (path === '/api/auth/status'
        ? () => Response.json(STATUS)
        : path === '/api/maintenance'
          ? () => Response.json(OFF)
          : () => new Response(null, { status: 404 }));
    return route();
  };
  return calls;
}

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

const settle = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function render(page: ReactNode, path: string) {
  window.history.replaceState(null, '', path);
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>),
  );
  await settle();
}

async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
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
  await settle();
}

const alertText = () => container.querySelector('[role="alert"]')?.textContent;

async function signIn() {
  await render(<LoginPage />, '/auth/login');
  await fill('#email', 'm.bell@northbrook.edu');
  await fill('#password', 'the-right-password');
  await submit();
}

it('says sign-in is unavailable, not that the password is wrong, while the database is down', async () => {
  const calls = serve({ '/api/auth/sign-in/email': outage });
  await signIn();

  expect(calls).toContain('/api/auth/sign-in/email');
  expect(alertText()).toBe('Sign-in is temporarily unavailable. Try again in a moment.');
  expect(container.textContent).not.toContain('Check your email and password');
  // The fields are not marked as the problem.
  expect(container.querySelector('#email')?.getAttribute('aria-invalid')).not.toBe('true');
  expect(container.querySelector<HTMLButtonElement>('#login-submit')?.disabled).toBe(false);
});

it('says the same while the API is down behind the proxy, or nothing answers', async () => {
  serve({ '/api/auth/sign-in/email': badGateway });
  await signIn();
  expect(alertText()).toBe('Sign-in is temporarily unavailable. Try again in a moment.');

  await act(async () => root.unmount());
  root = createRoot(container);
  serve({
    '/api/auth/sign-in/email': () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await signIn();
  expect(alertText()).toBe('Sign-in is temporarily unavailable. Try again in a moment.');
  expect(container.querySelector<HTMLButtonElement>('#login-submit')?.disabled).toBe(false);
});

it('still words a wrong password as the user guide does (#97)', async () => {
  serve({ '/api/auth/sign-in/email': wrongPassword });
  await signIn();
  expect(alertText()).toBe('Unable to sign in. Check your email and password.');
  expect(container.querySelector('#email')?.getAttribute('aria-invalid')).toBe('true');
});

it('does not say password sign-in is turned off when the status could not be loaded', async () => {
  serve({ '/api/auth/status': outage });
  await render(<LoginPage />, '/auth/login');
  // The status query retries once, a second later.
  await settle(1_200);
  expect(container.querySelector('form')).not.toBeNull();
  expect(container.textContent).not.toContain('Password sign-in is turned off');
});

it('says Forgot password is temporarily unavailable, not turned off, and recovers', async () => {
  const routes: Record<string, () => Response> = { '/api/auth/status': outage };
  serve(routes);
  await render(<ForgotPasswordPage />, '/auth/forgot-password');
  await settle(1_200);

  expect(container.textContent).toContain('Password reset temporarily unavailable');
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'The service is temporarily unavailable. Try again in a moment.',
  );
  expect(container.textContent).not.toContain('Contact an administrator');
  expect(container.querySelector('form')).toBeNull();

  // The database is back: Try again shows the form, with no reload.
  delete routes['/api/auth/status'];
  const retry = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  )!;
  await act(async () => retry.click());
  await settle();
  expect(container.querySelector('#reset-email')).not.toBeNull();
});

it('shows neither the form nor "unavailable" while the status is still loading', async () => {
  serve({ '/api/auth/status': () => new Promise<Response>(() => {}) as unknown as Response });
  await render(<ForgotPasswordPage />, '/auth/forgot-password');
  expect(container.textContent).not.toContain('Password reset unavailable');
  expect(container.textContent).not.toContain('Contact an administrator');
  expect(container.querySelector('form')).toBeNull();
});

it('says a reset request is unavailable, not failed for the account, while the database is down', async () => {
  serve({ '/api/auth/request-password-reset': outage });
  await render(<ForgotPasswordPage />, '/auth/forgot-password');
  await fill('#reset-email', 'm.bell@northbrook.edu');
  await submit();
  expect(alertText()).toBe('Password reset is temporarily unavailable. Try again in a moment.');
  expect(container.textContent).not.toContain('reset link has been sent');
});

it('does not call a working reset link invalid while the database is down', async () => {
  serve({ '/api/auth/reset-password': outage });
  await render(<ResetPasswordPage />, '/auth/reset-password?token=abc123');
  await fill('#new-password', 'a-new-long-password');
  await submit();
  expect(alertText()).toBe('Password reset is temporarily unavailable. Try again in a moment.');
  expect(container.textContent).not.toContain('invalid or expired');
});
