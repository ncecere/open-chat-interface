// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcceptInvitePage } from '../../src/routes/auth/accept-invite';
import { cleanup, renderAdmin, settle } from './admin-test-utils';

/**
 * The invitation page (#214), through the real API client and query cache,
 * against a network that answers as the API does: the address an emailed
 * invitation is for is filled in and fixed, instead of an empty field that
 * accepts only that one address.
 */
let validation: { emailLocked: boolean; email?: string | null };
const network = vi.hoisted(() => ({ requests: [] as string[] }));
beforeEach(() => {
  network.requests.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost:3000').pathname;
    network.requests.push(path);
    if (path === '/api/auth/accept-invite/validate') return Response.json(validation);
    if (path === '/api/auth/status') return Response.json({ branding: { appName: 'OCI' } });
    return new Response(null, { status: 404 });
  });
  window.history.replaceState(null, '', `/auth/accept-invite#token=${'t'.repeat(43)}`);
});
let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.unstubAllGlobals();
});

const emailField = () => document.querySelector<HTMLInputElement>('#invite-email')!;

it('fills in and fixes the address an emailed invitation is for', async () => {
  validation = { emailLocked: true, email: 'walk3-user@example.edu' };
  ({ root } = await renderAdmin(<AcceptInvitePage />));
  await settle();
  expect(network.requests).toContain('/api/auth/accept-invite/validate');
  expect(emailField().value).toBe('walk3-user@example.edu');
  expect(emailField().readOnly).toBe(true);
  const hint = document.getElementById(emailField().getAttribute('aria-describedby')!);
  expect(hint?.textContent).toBe('The address this invitation was sent to.');
});

it('leaves the address to the person for an invitation that is not for one', async () => {
  validation = { emailLocked: false, email: null };
  ({ root } = await renderAdmin(<AcceptInvitePage />));
  await settle();
  expect(emailField().value).toBe('');
  expect(emailField().readOnly).toBe(false);
});
