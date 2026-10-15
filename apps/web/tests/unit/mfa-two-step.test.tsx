// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { TwoStepVerification } from '../../src/routes/settings/account/two-step';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  settle,
  typeInto,
} from './admin-test-utils';
import { enrolledStatus, fieldRefusal, mfaStatus, PASSKEY, RECOVERY_CODES } from './mfa-fixtures';

/**
 * Settings → Account → Two-step verification (#399): the status, setting up an
 * authenticator (password, QR code and manual key, a confirming code, the
 * recovery codes once), new recovery codes and turning it off. The API is
 * faked at the api client, as settings-account.test.tsx does.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
  saveBlob,
}));
const authClient = vi.hoisted(() => ({
  passkey: { addPasskey: vi.fn(), updatePasskey: vi.fn(), deletePasskey: vi.fn() },
}));
vi.mock('../../src/lib/auth-client', () => ({ authClient }));

const URI = 'otpauth://totp/Open%20Chat%20Interface:pat%40example.test?secret=JBSWY3DPEHPK3PXP';
const NEXT_YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString();

let root: Root | undefined;
let client: QueryClient;
let status: ReturnType<typeof mfaStatus>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  status = mfaStatus();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me/mfa') return structuredClone(status);
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset();
  saveBlob.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
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
const errorAt = (input: HTMLInputElement) =>
  (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .find((node) => node?.getAttribute('role') === 'alert')?.textContent ?? null;

describe('the status', () => {
  it('is off for a person with nothing set up, and offers an authenticator', async () => {
    await render();
    expect(text()).toContain('Two-step verification');
    expect(text()).toMatch(/Status:\s*Off/);
    expect(findButton('Set up an authenticator app')).toBeDefined();
  });

  it('is on, with what is set up and how many recovery codes are left', async () => {
    status = enrolledStatus(8, [PASSKEY]);
    await render();
    expect(text()).toMatch(/Status:\s*On/);
    expect(text()).toContain('8 recovery codes left');
    expect(findButton('Set up an authenticator app')).toBeUndefined();
    expect(findButton('Get new recovery codes')).toBeDefined();
    expect(findButton('Turn off')).toBeDefined();
  });

  it('warns when the recovery codes run low, and says when none are left', async () => {
    status = enrolledStatus(1);
    await render();
    expect(text()).toContain('1 recovery code left');
    expect(text()).toContain('Get new ones before you run out');
    await cleanup(root!);
    status = enrolledStatus(0);
    await render();
    expect(text()).toContain('no recovery codes left');
  });

  it('says it is required, and by when', async () => {
    status = mfaStatus({ required: true, deadline: NEXT_YEAR });
    await render();
    expect(text()).toContain('Required by your administrator');
    expect(text()).toMatch(/Set it up by [A-Z][a-z]+ \d{1,2}, \d{4}/);
  });

  it('says a limited person must set it up to continue', async () => {
    status = mfaStatus({ required: true, limited: true, deadline: '2020-01-01T00:00:00.000Z' });
    await render();
    expect(text()).toContain('requires two-step verification');
    expect(text()).toContain('Set it up to continue');
  });

  it('says when the second step is locked after wrong codes', async () => {
    status = enrolledStatus(8, [], { lockedUntil: new Date(Date.now() + 600_000).toISOString() });
    await render();
    expect(text()).toContain('locked after too many wrong codes');
  });

  it('says "Managed by your organisation" for an account that signs in only through it', async () => {
    status = mfaStatus({ eligible: false });
    await render();
    expect(text()).toContain('Managed by your organisation');
    expect(findButton('Set up an authenticator app')).toBeUndefined();
    expect(findButton('Add a passkey')).toBeUndefined();
  });

  it('says it could not load, and tries again', async () => {
    api.get.mockRejectedValueOnce(new Error('down'));
    await render();
    expect(text()).toContain('could not be loaded');
    await click(button('Try again'));
    expect(text()).toMatch(/Status:\s*Off/);
  });
});

describe('setting up an authenticator', () => {
  async function start() {
    await render();
    await click(button('Set up an authenticator app'));
  }
  async function enterPassword(password = 'Correct-horse-1') {
    await typeInto(field('Current password'), password);
    await click(button('Continue'));
  }
  const scanned = { totpURI: URI, manualKey: 'JBSWY3DPEHPK3PXP' };

  it('asks for the password first, with the right autofill token, and checks it is there', async () => {
    await start();
    const password = field('Current password');
    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    await click(button('Continue'));
    expect(errorAt(password)).toBe('Enter your password.');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a wrong password under the password field', async () => {
    api.post.mockRejectedValueOnce(fieldRefusal('password', 'Your password is not correct.'));
    await start();
    await enterPassword('wrong');
    const password = field('Current password');
    expect(errorAt(password)).toBe('Your password is not correct.');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(api.post).toHaveBeenCalledWith('/me/mfa/totp', { password: 'wrong' });
  });

  it('shows the QR code, the manual key in groups, and the link for a phone', async () => {
    api.post.mockResolvedValueOnce(scanned);
    await start();
    await enterPassword();
    const svg = document.querySelector('svg[aria-hidden="true"][viewBox]');
    expect(svg).not.toBeNull();
    expect(text()).toContain('JBSW Y3DP EHPK 3PXP');
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Open in your authenticator app',
    );
    expect(link?.getAttribute('href')).toBe(URI);
    // The key is selectable text, and has a Copy button of its own.
    expect(document.querySelector('[data-testid="manual-key"]')?.textContent).toBe(
      'JBSW Y3DP EHPK 3PXP',
    );
    await click(button('Copy key'));
    expect(writeText).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');
  });

  it('takes the confirming code as a paste, with the autofill token and no length limit (SC 3.3.8)', async () => {
    api.post.mockResolvedValueOnce(scanned);
    await start();
    await enterPassword();
    const code = field('Authentication code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.hasAttribute('maxlength')).toBe(false);

    api.post.mockResolvedValueOnce({ recoveryCodes: RECOVERY_CODES });
    await typeInto(code, '123 456');
    await click(button('Turn on'));
    expect(api.post).toHaveBeenLastCalledWith('/me/mfa/totp/confirm', { code: '123456' });
  });

  it('keeps the form and says so under the code field when the code is wrong', async () => {
    api.post.mockResolvedValueOnce(scanned);
    await start();
    await enterPassword();
    api.post.mockRejectedValueOnce(
      fieldRefusal(
        'code',
        'That code is not right. Check the code in your authenticator app and try again.',
      ),
    );
    await typeInto(field('Authentication code'), '000000');
    await click(button('Turn on'));
    const code = field('Authentication code');
    expect(errorAt(code)).toContain('That code is not right');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('svg[aria-hidden="true"][viewBox]')).not.toBeNull();
  });

  it('starts again from the password when nothing is waiting to be confirmed', async () => {
    api.post.mockResolvedValueOnce(scanned);
    await start();
    await enterPassword();
    api.post.mockRejectedValueOnce(
      new ApiError(
        409,
        'CONFLICT',
        'There is nothing to confirm. Start again from "Set up an authenticator app".',
      ),
    );
    await typeInto(field('Authentication code'), '123456');
    await click(button('Turn on'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('nothing to confirm');
    expect(field('Current password')).toBeDefined();
  });

  describe('the recovery codes', () => {
    async function throughConfirmation() {
      api.post.mockResolvedValueOnce(scanned);
      await start();
      await enterPassword();
      api.post.mockImplementationOnce(async () => {
        // The confirmation turned the second step on.
        status = enrolledStatus(10);
        return { recoveryCodes: RECOVERY_CODES };
      });
      await typeInto(field('Authentication code'), '123456');
      await click(button('Turn on'));
    }

    it('are shown once, all ten, and Done waits for "I saved them"', async () => {
      await throughConfirmation();
      const items = [...document.querySelectorAll('[data-testid="recovery-code"]')];
      expect(items.map((item) => item.textContent)).toEqual(RECOVERY_CODES);
      expect(text()).toContain('You will not be able to see these again');

      const done = button('Done');
      expect(done.disabled || done.getAttribute('aria-disabled') === 'true').toBe(true);
      const saved = field('I have saved my recovery codes');
      expect(saved.type).toBe('checkbox');
      await click(saved);
      expect(button('Done').disabled).toBe(false);
    });

    it('can be copied and downloaded', async () => {
      await throughConfirmation();
      await click(button('Copy codes'));
      expect(writeText).toHaveBeenCalledWith(RECOVERY_CODES.join('\n'));
      expect(text()).toContain('Copied');

      await click(button('Download codes'));
      expect(saveBlob).toHaveBeenCalledTimes(1);
      const [blob, name] = saveBlob.mock.calls[0]!;
      expect(name).toBe('recovery-codes.txt');
      const content = await (blob as Blob).text();
      for (const code of RECOVERY_CODES) expect(content).toContain(code);
    });

    it('go when Done is pressed, and were never kept in the cache or in storage', async () => {
      await throughConfirmation();
      await click(field('I have saved my recovery codes'));
      await click(button('Done'));

      expect(text()).not.toContain(RECOVERY_CODES[0]);
      expect(document.querySelector('[data-testid="recovery-code"]')).toBeNull();
      // Set up now: the status says so.
      expect(text()).toMatch(/Status:\s*On/);

      const held = JSON.stringify([
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
        { ...localStorage },
        { ...sessionStorage },
        window.location.href,
      ]);
      for (const code of RECOVERY_CODES) expect(held).not.toContain(code);
    });

    it('refreshes what /api/me says, because confirming replaced the session', async () => {
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      await throughConfirmation();
      // Exactly /api/me, not every query under it: the onboarding answer is not asked again.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'], exact: true });
    });
  });

  it('can be cancelled before the code is confirmed', async () => {
    api.post.mockResolvedValueOnce(scanned);
    await start();
    await enterPassword();
    await click(button('Cancel'));
    expect(findButton('Set up an authenticator app')).toBeDefined();
    expect(document.querySelector('svg[aria-hidden="true"][viewBox]')).toBeNull();
  });
});

describe('new recovery codes', () => {
  beforeEach(() => {
    status = enrolledStatus(3);
  });

  async function open() {
    await render();
    await click(button('Get new recovery codes'));
    return dialog()!;
  }

  it('asks for the password and a current code, and says the old codes stop working', async () => {
    const box = await open();
    expect(box.textContent).toContain('The codes you have now will stop working');
    expect(field('Current password').getAttribute('autocomplete')).toBe('current-password');
    const code = field('Authentication or recovery code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.hasAttribute('maxlength')).toBe(false);
    await click(button('Get new codes'));
    expect(errorAt(field('Current password'))).toBe('Enter your password.');
    expect(errorAt(code)).toBe('Enter a code from your authenticator app, or a recovery code.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a wrong code under its field', async () => {
    api.post.mockRejectedValueOnce(fieldRefusal('code', 'That code is not right.'));
    await open();
    await typeInto(field('Current password'), 'Correct-horse-1');
    await typeInto(field('Authentication or recovery code'), '111111');
    await click(button('Get new codes'));
    expect(errorAt(field('Authentication or recovery code'))).toBe('That code is not right.');
    expect(api.post).toHaveBeenCalledWith('/me/mfa/recovery-codes', {
      password: 'Correct-horse-1',
      code: '111111',
    });
  });

  it('sends a spaced code without the spaces and a recovery code as typed', async () => {
    api.post.mockResolvedValue({ recoveryCodes: RECOVERY_CODES });
    await open();
    await typeInto(field('Current password'), 'pw');
    await typeInto(field('Authentication or recovery code'), '123 456');
    await click(button('Get new codes'));
    expect(api.post).toHaveBeenLastCalledWith('/me/mfa/recovery-codes', {
      password: 'pw',
      code: '123456',
    });
  });

  it('shows the new codes once, gated by "I saved them", and the dialog closes on Done', async () => {
    api.post.mockResolvedValueOnce({ recoveryCodes: RECOVERY_CODES });
    await open();
    await typeInto(field('Current password'), 'Correct-horse-1');
    await typeInto(field('Authentication or recovery code'), 'aB3dE-fG5hJ');
    await click(button('Get new codes'));
    expect(api.post).toHaveBeenCalledWith('/me/mfa/recovery-codes', {
      password: 'Correct-horse-1',
      code: 'aB3dE-fG5hJ',
    });
    expect(
      [...document.querySelectorAll('[data-testid="recovery-code"]')].map((n) => n.textContent),
    ).toEqual(RECOVERY_CODES);
    expect(button('Done').disabled).toBe(true);
    await click(field('I have saved my recovery codes'));
    await click(button('Done'));
    expect(dialog()).toBeNull();
    expect(text()).not.toContain(RECOVERY_CODES[0]);
  });

  it('says a locked second step is locked, in words', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(
        429,
        'RATE_LIMITED',
        'Too many wrong codes. Two-step verification is locked for a while.',
      ),
    );
    await open();
    await typeInto(field('Current password'), 'pw');
    await typeInto(field('Authentication or recovery code'), '111111');
    await click(button('Get new codes'));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('locked for a while');
  });
});

describe('turning the authenticator off', () => {
  beforeEach(() => {
    status = enrolledStatus(8);
  });

  it('asks for the password and a current code, and does it', async () => {
    api.post.mockImplementationOnce(async () => {
      status = mfaStatus();
      return { ok: true };
    });
    await render();
    await click(button('Turn off'));
    expect(dialog()?.textContent).toContain('Turn off the authenticator app?');
    await typeInto(field('Current password'), 'Correct-horse-1');
    await typeInto(field('Authentication or recovery code'), '654 321');
    await click(button('Turn off authenticator'));
    expect(api.post).toHaveBeenCalledWith('/me/mfa/totp/disable', {
      password: 'Correct-horse-1',
      code: '654321',
    });
    expect(dialog()).toBeNull();
    expect(text()).toContain('The authenticator app is turned off');
    expect(text()).toMatch(/Status:\s*Off/);
  });

  it('keeps the dialog open and says why when the password is wrong', async () => {
    api.post.mockRejectedValueOnce(fieldRefusal('password', 'Your password is not correct.'));
    await render();
    await click(button('Turn off'));
    await typeInto(field('Current password'), 'nope');
    await typeInto(field('Authentication or recovery code'), '654321');
    await click(button('Turn off authenticator'));
    expect(dialog()).not.toBeNull();
    expect(errorAt(field('Current password'))).toBe('Your password is not correct.');
    await settle();
  });

  it('can be cancelled', async () => {
    await render();
    await click(button('Turn off'));
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
