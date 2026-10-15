// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MfaSetupPage } from '../../src/routes/auth/mfa-setup';
import { button, cleanup, click, findButton, renderAdmin, typeInto } from './admin-test-utils';
import { enrolledStatus, mfaStatus, PASSKEY, RECOVERY_CODES } from './mfa-fixtures';

/**
 * The page a limited person is sent to (#399): enrolment and Sign out, nothing
 * else, outside the app shell. Reached while the server refuses every other
 * request of the session (403 MFA_ENROLMENT_REQUIRED).
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const authClient = vi.hoisted(() => ({
  signOut: vi.fn(),
  passkey: { addPasskey: vi.fn(), updatePasskey: vi.fn(), deletePasskey: vi.fn() },
}));
vi.mock('../../src/lib/auth-client', () => ({ authClient }));

const URI = 'otpauth://totp/Open%20Chat%20Interface:pat%40example.test?secret=JBSWY3DPEHPK3PXP';

let root: Root | undefined;
let client: QueryClient;
let router: Awaited<ReturnType<typeof renderAdmin>>['router'];
let status: ReturnType<typeof mfaStatus>;

beforeEach(() => {
  status = mfaStatus({ required: true, limited: true, deadline: '2026-10-01T00:00:00.000Z' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me/mfa') return structuredClone(status);
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset();
  authClient.signOut.mockReset().mockResolvedValue({ data: { success: true }, error: null });
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

const render = async () => {
  ({ root, router } = await renderAdmin(<MfaSetupPage />, {
    path: '/auth/mfa-setup',
    queryClient: client,
  }));
};
const text = () => document.body.textContent ?? '';
function field(label: string): HTMLInputElement {
  const labelElement = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label,
  );
  const input = labelElement && document.getElementById(labelElement.htmlFor);
  if (!input) throw new Error(`No field labelled "${label}"`);
  return input as HTMLInputElement;
}

describe('a person who has not set anything up', () => {
  it('is told why, and is offered enrolment and Sign out only', async () => {
    await render();
    expect(document.querySelector('main h1')?.textContent).toBe('Set up two-step verification');
    expect(text()).toContain('Your administrator requires two-step verification');
    expect(findButton('Set up an authenticator app')).toBeDefined();
    expect(findButton('Sign out')).toBeDefined();
    // Nothing to manage yet, and a passkey needs a recent sign-in: enrolment only.
    expect(findButton('Add a passkey')).toBeUndefined();
    expect(findButton('Turn off')).toBeUndefined();
    expect(findButton('Get new recovery codes')).toBeUndefined();
  });

  it('sets up an authenticator, saves the codes, and then goes to the app', async () => {
    api.post.mockResolvedValueOnce({ totpURI: URI, manualKey: 'JBSWY3DPEHPK3PXP' });
    await render();
    await click(button('Set up an authenticator app'));
    await typeInto(field('Current password'), 'Correct-horse-1');
    await click(button('Continue'));
    api.post.mockImplementationOnce(async () => {
      status = enrolledStatus(10, [], { limited: false, required: true });
      return { recoveryCodes: RECOVERY_CODES };
    });
    await typeInto(field('Authentication code'), '123 456');
    await click(button('Turn on'));
    expect(api.post).toHaveBeenLastCalledWith('/me/mfa/totp/confirm', { code: '123456' });

    // Not yet: the codes are shown once, and Done waits for "I saved them".
    expect(router.state.location.pathname).toBe('/auth/mfa-setup');
    expect(text()).toContain(RECOVERY_CODES[0]);
    await click(field('I have saved my recovery codes'));
    await click(button('Done'));
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('a person who has a second step but whose session used the password alone', () => {
  it('is told to sign in again with their code or passkey, and offered nothing else', async () => {
    status = enrolledStatus(8, [PASSKEY], { required: true, limited: true });
    await render();
    expect(text()).toContain('this session was opened with your password only');
    expect(text()).toContain('Sign out and sign in again');
    expect(findButton('Sign out')).toBeDefined();
    expect(findButton('Set up an authenticator app')).toBeUndefined();
    expect(findButton('Turn off')).toBeUndefined();
  });
});

describe('Sign out', () => {
  it('signs out, drops what was cached, and goes to sign-in', async () => {
    client.setQueryData(['marker'], 1);
    await render();
    await click(button('Sign out'));
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(['marker'])).toBeUndefined();
    expect(router.state.location.pathname).toBe('/auth/login');
  });
});
