// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoStepVerification } from '../../src/routes/settings/account/two-step';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
} from './admin-test-utils';
import { enrolledStatus, mfaStatus, PASSKEY } from './mfa-fixtures';

/**
 * Passkeys under Settings → Account → Two-step verification (#399): the list
 * (OCI's own, never the plugin's), add, rename and remove through the passkey
 * client, a clear message when the browser has no WebAuthn, and what each
 * refusal says.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const authClient = vi.hoisted(() => ({
  passkey: { addPasskey: vi.fn(), updatePasskey: vi.fn(), deletePasskey: vi.fn() },
}));
vi.mock('../../src/lib/auth-client', () => ({ authClient }));

const SYNCED = {
  id: 'pk2',
  name: 'Phone',
  createdAt: '2026-09-15T10:00:00.000Z',
  deviceType: 'multiDevice',
  backedUp: true,
};

let root: Root | undefined;
let client: QueryClient;
let status: ReturnType<typeof mfaStatus>;

beforeEach(() => {
  status = mfaStatus({ enrolled: true, methods: ['passkey'], passkeys: [PASSKEY, SYNCED] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me/mfa') return structuredClone(status);
    throw new Error(`Unexpected GET ${path}`);
  });
  for (const mock of Object.values(authClient.passkey)) mock.mockReset();
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

const render = async () => {
  ({ root } = await renderAdmin(<TwoStepVerification />, { queryClient: client }));
};
function field(label: string): HTMLInputElement {
  const labelElement = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label,
  );
  const input = labelElement && document.getElementById(labelElement.htmlFor);
  if (!input) throw new Error(`No field labelled "${label}"`);
  return input as HTMLInputElement;
}
const text = () => document.body.textContent ?? '';

describe('the list', () => {
  it('names each passkey, when it was added, and whether it syncs', async () => {
    await render();
    const items = [...document.querySelectorAll('[data-testid="passkey"]')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Work laptop');
    expect(items[0]?.textContent).toContain('Added September 1, 2026');
    expect(items[0]?.textContent).toContain('This device only');
    expect(items[1]?.textContent).toContain('Phone');
    expect(items[1]?.textContent).toContain('Synced across your devices');
    expect(text()).toContain('2 passkeys');
  });

  it('says there are none yet', async () => {
    status = mfaStatus();
    await render();
    expect(text()).toContain('No passkeys yet');
  });

  it('is read from the OCI route, not the passkey plugin', async () => {
    await render();
    expect(api.get).toHaveBeenCalledWith('/me/mfa');
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('list-user-passkeys'));
  });
});

describe('a browser without WebAuthn', () => {
  it('says so, and offers no Add', async () => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    await render();
    expect(findButton('Add a passkey')).toBeUndefined();
    expect(text()).toContain('This browser cannot make passkeys');
    // The ones already registered can still be renamed and removed.
    expect(findButton('Remove Work laptop')).toBeDefined();
  });
});

describe('adding a passkey', () => {
  async function open() {
    await render();
    await click(button('Add a passkey'));
    return dialog()!;
  }

  it('asks for an optional name, then the browser asks for the passkey', async () => {
    authClient.passkey.addPasskey.mockImplementation(async () => {
      status = {
        ...status,
        passkeys: [...status.passkeys, { ...SYNCED, id: 'pk3', name: 'Tablet' }],
      };
      return { data: { id: 'pk3' }, error: null };
    });
    const box = await open();
    expect(box.textContent).toContain('Add a passkey');
    expect(box.textContent).toContain('Optional');
    await typeInto(field('Name'), '  Tablet ');
    await click(button('Add passkey'));
    expect(authClient.passkey.addPasskey).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tablet' }),
    );
    expect(dialog()).toBeNull();
    expect(text()).toContain('Passkey added');
    expect(text()).toContain('Tablet');
  });

  it('sends no name when none was typed, and the server names it', async () => {
    authClient.passkey.addPasskey.mockResolvedValue({ data: { id: 'pk3' }, error: null });
    await open();
    await click(button('Add passkey'));
    expect(authClient.passkey.addPasskey.mock.calls[0]![0].name).toBeUndefined();
  });

  it('says to sign in again when the session is not recent enough', async () => {
    authClient.passkey.addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'SESSION_NOT_FRESH', status: 403, message: 'Session is not fresh' },
    });
    const box = await open();
    await click(button('Add passkey'));
    expect(box.querySelector('[role="alert"]')?.textContent).toBe(
      'For your security, adding a passkey needs a recent sign-in. Sign out, enter your password and sign in again, then add the passkey.',
    );
    expect(dialog()).not.toBeNull();
  });

  it('says calmly that it was cancelled, and leaves the dialog open to try again', async () => {
    authClient.passkey.addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_CEREMONY_ABORTED', status: 400, message: 'Registration cancelled' },
    });
    const box = await open();
    await click(button('Add passkey'));
    expect(box.querySelector('[role="status"]')?.textContent).toBe(
      'The passkey request was cancelled or timed out. Try again when you are ready.',
    );
    expect(box.querySelector('[role="alert"]')).toBeNull();
  });

  it('says when this device already has a passkey for the account', async () => {
    authClient.passkey.addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', status: 400, message: 'x' },
    });
    const box = await open();
    await click(button('Add passkey'));
    expect(box.querySelector('[role="alert"]')?.textContent).toBe(
      'This device already has a passkey for your account. Use another device or security key, or remove the old passkey first.',
    );
  });

  it('says a single sign-on account cannot add one', async () => {
    authClient.passkey.addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'PASSKEY_NOT_AVAILABLE', status: 409, message: 'x' },
    });
    const box = await open();
    await click(button('Add passkey'));
    expect(box.querySelector('[role="alert"]')?.textContent).toBe(
      'Your account signs in through your organisation, so passkeys are not available.',
    );
  });

  it('keeps the dialog and says it when the service is down', async () => {
    authClient.passkey.addPasskey.mockRejectedValue(new TypeError('Failed to fetch'));
    const box = await open();
    await click(button('Add passkey'));
    expect(box.querySelector('[role="alert"]')?.textContent).toBe(
      'Passkeys are temporarily unavailable. Try again in a moment.',
    );
  });
});

describe('renaming a passkey', () => {
  it('saves the new name', async () => {
    authClient.passkey.updatePasskey.mockResolvedValue({ data: { passkey: {} }, error: null });
    await render();
    await click(button('Rename Work laptop'));
    expect(field('Name').value).toBe('Work laptop');
    await typeInto(field('Name'), 'Home desktop');
    await click(button('Save name'));
    expect(authClient.passkey.updatePasskey).toHaveBeenCalledWith({
      id: 'pk1',
      name: 'Home desktop',
    });
    expect(dialog()).toBeNull();
    expect(text()).toContain('Passkey renamed');
  });

  it('wants a name', async () => {
    await render();
    await click(button('Rename Work laptop'));
    await typeInto(field('Name'), '   ');
    await click(button('Save name'));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Enter a name.');
    expect(field('Name').getAttribute('aria-invalid')).toBe('true');
    expect(authClient.passkey.updatePasskey).not.toHaveBeenCalled();
  });

  it('says why when the server refuses', async () => {
    authClient.passkey.updatePasskey.mockResolvedValue({
      data: null,
      error: {
        code: 'FORBIDDEN',
        status: 403,
        message: 'You are not allowed to change this passkey.',
      },
    });
    await render();
    await click(button('Rename Work laptop'));
    await typeInto(field('Name'), 'x');
    await click(button('Save name'));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      'You are not allowed to change this passkey.',
    );
  });
});

describe('removing a passkey', () => {
  it('asks first, and says which one', async () => {
    await render();
    await click(button('Remove Work laptop'));
    expect(dialog()?.textContent).toContain('Remove this passkey?');
    expect(dialog()?.textContent).toContain('Work laptop');
    expect(authClient.passkey.deletePasskey).not.toHaveBeenCalled();
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
    expect(authClient.passkey.deletePasskey).not.toHaveBeenCalled();
  });

  it('removes it and shows the list without it', async () => {
    authClient.passkey.deletePasskey.mockImplementation(async () => {
      status = { ...status, passkeys: [SYNCED] };
      return { data: { status: true }, error: null };
    });
    await render();
    await click(button('Remove Work laptop'));
    await click(button('Remove passkey'));
    expect(authClient.passkey.deletePasskey).toHaveBeenCalledWith({ id: 'pk1' });
    expect(dialog()).toBeNull();
    expect(text()).toContain('Passkey removed');
    expect(document.querySelectorAll('[data-testid="passkey"]')).toHaveLength(1);
  });

  it('keeps the dialog open and says why when it fails', async () => {
    authClient.passkey.deletePasskey.mockResolvedValue({
      data: null,
      error: { code: 'NOT_FOUND', status: 404, message: 'Passkey not found' },
    });
    await render();
    await click(button('Remove Work laptop'));
    await click(button('Remove passkey'));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Passkey not found');
  });
});

describe('with an authenticator too', () => {
  it('lists the passkeys beside the recovery codes', async () => {
    status = enrolledStatus(8, [PASSKEY]);
    await render();
    expect(text()).toContain('8 recovery codes left');
    expect(text()).toContain('1 passkey');
    expect(findButton('Add a passkey')).toBeDefined();
  });
});
