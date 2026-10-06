// @vitest-environment happy-dom
import type { ReadOnlyStatus } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setReadOnlyStatus } from '../../src/lib/read-only';
import { ForgotPasswordPage } from '../../src/routes/auth/password-reset';

/**
 * Forgot password while read-only (#138). The API refuses the reset with 423
 * READ_ONLY and sends no email; the page said "a password reset link has been
 * sent" anyway. The real Better Auth client runs here, against a fetch that
 * answers as the API does, so the error's real shape is what the page reads.
 */
// Installed before the auth client is created, which keeps the fetch it finds.
const network = vi.hoisted(() => {
  const state = {
    handler: (async () => new Response(null, { status: 404 })) as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>,
  };
  globalThis.fetch = (input, init) => state.handler(input, init);
  return state;
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../src/hooks/use-auth-status', () => ({
  useAuthStatus: () => ({
    data: { localAuthEnabled: true, smtpConfigured: true, branding: {} },
    isLoading: false,
  }),
}));

const OFF: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};
const until = new Date(Date.now() + 90 * 60_000).toISOString();
const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Walk3 resilience read-only test',
  until,
  window: null,
};

/** What the API answers: /api/maintenance, and the reset per `reset`. */
function serve(maintenance: ReadOnlyStatus, reset: () => Response) {
  const calls: string[] = [];
  network.handler = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/maintenance') return Response.json(maintenance);
    if (url.pathname === '/api/auth/request-password-reset') return reset();
    return new Response(null, { status: 404 });
  };
  return calls;
}
/** The read-only guard's refusal (apps/api/src/middleware/read-only.ts). */
const refused = () =>
  Response.json(
    {
      error: {
        code: 'READ_ONLY',
        message: 'This service is read-only for maintenance.',
        details: { readOnly: ON },
      },
    },
    { status: 423, headers: { 'X-OCI-Read-Only': 'administrator' } },
  );

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setReadOnlyStatus(OFF);
  window.history.replaceState(null, '', '/auth/forgot-password');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  setReadOnlyStatus(OFF);
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ForgotPasswordPage />
      </QueryClientProvider>,
    ),
  );
  // The read-only status request.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function send(email: string) {
  const input = container.querySelector<HTMLInputElement>('#reset-email')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, email);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

it('says resets are paused, not that a link was sent, when the reset races read-only', async () => {
  // The page loaded before read-only started; the send is refused.
  const calls = serve(OFF, refused);
  await render();
  expect(container.querySelector('form')).not.toBeNull();
  await send('h.sato@northbrook.edu');

  expect(calls).toContain('POST /api/auth/request-password-reset');
  expect(container.textContent).not.toContain('reset link has been sent');
  expect(container.textContent).not.toContain('Check your email');
  expect(container.textContent).toContain('Password reset paused');
  expect(container.textContent).toContain('no reset email has been sent');
  expect(container.textContent).toContain('Walk3 resilience read-only test.');
  expect(container.querySelector('form')).toBeNull();
});

it('says so before anyone sends while read-only is on', async () => {
  serve(ON, refused);
  await render();
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(
    /^Password resets are paused for maintenance until about .+, and no reset email has been sent\./,
  );
});

it('still answers the same way for any address when the reset is accepted', async () => {
  serve(OFF, () => Response.json({ status: true }));
  await render();
  await send('nobody@northbrook.edu');
  // It does not claim the email was sent, which was not known (#327).
  expect(container.textContent).toContain(
    'If an account uses this address, a password reset link is on its way.',
  );
  expect(container.textContent).not.toContain('has been sent');
});

it('shows a refusal that is not about the account, such as the rate limit', async () => {
  serve(OFF, () =>
    Response.json(
      {
        message: 'Too many attempts. Wait a minute and try again.',
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' },
      },
      { status: 429 },
    ),
  );
  await render();
  await send('h.sato@northbrook.edu');
  expect(container.textContent).not.toContain('reset link has been sent');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Too many attempts. Wait a minute and try again.',
  );
});
