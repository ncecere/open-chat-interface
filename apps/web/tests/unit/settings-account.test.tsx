// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeUserAgent } from '../../src/lib/user-agent';
import { SettingsAccountPage } from '../../src/routes/settings/account';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
} from './admin-test-utils';

/**
 * Settings → Account (v0.9.1): the password control follows how the person
 * signs in, devices can be listed and signed out, the name can be edited on
 * a password account, and changing the email is gone. Deleting the account
 * (v0.10) is offered only when the role allows it.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const authClient = vi.hoisted(() => ({ changePassword: vi.fn(), updateUser: vi.fn() }));
vi.mock('../../src/lib/auth-client', () => ({ authClient }));

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let root: Root | undefined;
let signIn: { password: boolean; credential: boolean; sso: string[] } | undefined;
let features: Record<string, boolean>;
beforeEach(() => {
  signIn = { password: true, credential: true, sso: [] };
  features = {};
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: {
          id: 'u1',
          name: 'Ada Admin',
          email: 'ada@example.test',
          role: 'user',
          emailVerified: true,
        },
        preferences: {},
        features,
        signIn,
      };
    if (path === '/me/sessions')
      return {
        sessions: [
          {
            id: 's1',
            current: true,
            userAgent: MAC_CHROME,
            ipAddress: '203.0.113.x',
            impersonated: false,
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            lastActiveAt: new Date().toISOString(),
          },
          {
            id: 's2',
            current: false,
            userAgent: IPHONE_SAFARI,
            ipAddress: '198.51.100.x',
            impersonated: false,
            createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(),
          },
        ],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ revoked: 1 });
  api.delete.mockReset().mockResolvedValue({ ok: true });
  authClient.changePassword.mockReset().mockResolvedValue({ data: {}, error: null });
  authClient.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

let router: Awaited<ReturnType<typeof renderAdmin>>['router'];
const render = async () => {
  ({ root, router } = await renderAdmin(<SettingsAccountPage />, { path: '/settings' }));
};

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement {
  const labelElement = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label,
  );
  const input = labelElement && document.getElementById(labelElement.htmlFor);
  if (!input) throw new Error(`No field labelled "${label}"`);
  return input as HTMLInputElement;
}

async function submitPassword(current: string, next: string, confirm = next) {
  await type(field('Current password'), current);
  await type(field('New password'), next);
  await type(field('Confirm new password'), confirm);
  const submit = [...dialog()!.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
  await click(submit);
}

describe('Settings → Account', () => {
  it('has no email change or account deletion, and says who deletes accounts', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Change Email');
    expect(text).not.toContain('Delete Account');
    expect(text).not.toContain('Danger Zone');
    expect(text).toContain('To delete your account, contact your administrator.');
    expect(text).toContain('Security & Access');
  });

  describe('deleting your account (v0.10)', () => {
    const confirmButton = () => button('Delete my account');

    it('is offered only when the role allows it', async () => {
      features = { accountDeletion: true };
      await render();
      const text = document.body.textContent ?? '';
      expect(text).not.toContain('contact your administrator');
      expect(document.getElementById('delete-account-heading')?.textContent).toBe('Delete account');
    });

    it('says what is deleted and kept, and needs the email and password typed', async () => {
      features = { accountDeletion: true };
      api.post.mockResolvedValue({ ok: true });
      await render();
      await click(button('Delete account'));

      const text = dialog()?.textContent ?? '';
      expect(text).toContain('Delete your account?');
      expect(text).toContain('conversations and their messages');
      expect(text).toContain('share links');
      expect(text).toContain('The audit log keeps every entry');
      // Usage is kept for reports, without the person (v0.10).
      expect(text).toContain(
        'Usage records (messages, tokens and cost per model) are kept without anything that identifies you',
      );
      expect(text).not.toMatch(/everything it owns:[^.]*usage records/);
      expect(text).not.toContain('a new, empty account');
      expect(confirmButton().disabled).toBe(true);

      await type(field('Type ada@example.test to confirm'), 'ADA@example.test ');
      expect(confirmButton().disabled).toBe(true);
      await type(field('Your password'), 'Secret-password-1');
      expect(confirmButton().disabled).toBe(false);
      await click(confirmButton());

      expect(api.post).toHaveBeenCalledWith('/me/delete-account', {
        confirmEmail: 'ADA@example.test ',
        password: 'Secret-password-1',
      });
      expect(router.state.location.pathname).toBe('/auth/login');
    });

    it('explains that signing in through the organisation again creates a new, empty account', async () => {
      features = { accountDeletion: true };
      signIn = { password: false, credential: false, sso: ['Campus SSO'] };
      api.post.mockResolvedValue({ ok: true });
      await render();
      await click(button('Delete account'));

      expect(dialog()?.textContent).toContain(
        'You sign in through Campus SSO. If you sign in that way again later, a new, empty account is created for you.',
      );
      expect(() => field('Your password')).toThrow();
      await type(field('Type ada@example.test to confirm'), 'ada@example.test');
      await click(confirmButton());
      expect(api.post).toHaveBeenCalledWith('/me/delete-account', {
        confirmEmail: 'ada@example.test',
      });
    });

    it('shows why the server refused, such as a legal hold', async () => {
      const { ApiError } = await import('../../src/lib/api-client');
      features = { accountDeletion: true };
      api.post.mockRejectedValue(
        new ApiError(
          409,
          'CONFLICT',
          'Deleting your account is paused by your organization. Contact your administrator if you need it deleted.',
        ),
      );
      await render();
      await click(button('Delete account'));
      await type(field('Type ada@example.test to confirm'), 'ada@example.test');
      await type(field('Your password'), 'Secret-password-1');
      await click(confirmButton());

      expect(alerts()).toContain(
        'Your account could not be deleted. Deleting your account is paused by your organization. Contact your administrator if you need it deleted.',
      );
      expect(dialog()).not.toBeNull();
      expect(router.state.location.pathname).toBe('/settings');
    });
  });

  describe('password', () => {
    it('changes the password, signing other devices out by default', async () => {
      await render();
      await click(button('Change Password'));
      expect(dialog()?.textContent).toContain('Change password');
      await submitPassword('Old-password-123', 'New-password-4567');
      expect(authClient.changePassword).toHaveBeenCalledWith({
        currentPassword: 'Old-password-123',
        newPassword: 'New-password-4567',
        revokeOtherSessions: true,
      });
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        'Your password has been changed and your other devices have been signed out.',
      );
    });

    it('can keep other devices signed in', async () => {
      await render();
      await click(button('Change Password'));
      const keep = [...dialog()!.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Sign out of all other devices'))!
        .querySelector('input')!;
      await click(keep);
      await submitPassword('Old-password-123', 'New-password-4567');
      expect(authClient.changePassword).toHaveBeenCalledWith(
        expect.objectContaining({ revokeOtherSessions: false }),
      );
      expect(dialog()?.textContent).toContain('Your password has been changed.');
    });

    it.each([
      ['a short password', 'short', 'short', 'at least 12 characters'],
      ['passwords that differ', 'New-password-4567', 'New-password-4568', 'do not match'],
      ['the same password', 'Old-password-123', 'Old-password-123', 'different from your current'],
    ])('refuses %s before asking the server', async (_label, next, confirm, message) => {
      await render();
      await click(button('Change Password'));
      await submitPassword('Old-password-123', next, confirm);
      expect(authClient.changePassword).not.toHaveBeenCalled();
      expect(alerts(dialog()!).join(' ')).toContain(message);
    });

    it('explains a wrong current password', async () => {
      authClient.changePassword.mockResolvedValue({
        data: null,
        error: { code: 'INVALID_PASSWORD', message: 'Invalid password', status: 400 },
      });
      await render();
      await click(button('Change Password'));
      await submitPassword('Wrong-password-1', 'New-password-4567');
      expect(alerts(dialog()!)).toEqual(['Your current password is not correct.']);
    });

    it('says local sign-in is off instead of offering a change that would be refused', async () => {
      signIn = { password: false, credential: true, sso: [] };
      await render();
      expect(findButton('Change Password')).toBeUndefined();
      expect(document.body.textContent).toContain(
        'Email and password sign-in is turned off on this instance.',
      );
    });

    it('says the organisation manages the password of an SSO account', async () => {
      signIn = { password: false, credential: false, sso: ['Campus Login'] };
      await render();
      expect(findButton('Change Password')).toBeUndefined();
      expect(document.body.textContent).toContain(
        "Your password is managed by your organisation's sign-in.",
      );
    });
  });

  describe('name', () => {
    it('edits a password account’s name', async () => {
      await render();
      await click(button('Edit name'));
      await type(field('Name'), '  Ada Lovelace ');
      await click(button('Save'));
      expect(authClient.updateUser).toHaveBeenCalledWith({ name: 'Ada Lovelace' });
      expect(document.body.textContent).toContain('Saved');
    });

    it('refuses an empty name', async () => {
      await render();
      await click(button('Edit name'));
      await type(field('Name'), '   ');
      await click(button('Save'));
      expect(authClient.updateUser).not.toHaveBeenCalled();
      expect(alerts()).toEqual(['Your name must be 1 to 100 characters.']);
    });

    it('shows the server’s reason when the name is refused', async () => {
      authClient.updateUser.mockResolvedValue({
        data: null,
        error: { code: 'PROFILE_MANAGED_BY_SSO', status: 403 },
      });
      await render();
      await click(button('Edit name'));
      await type(field('Name'), 'Someone');
      await click(button('Save'));
      expect(alerts()).toEqual(["Your name comes from your organisation's sign-in."]);
    });

    it('leaves the name and email of an SSO account to the organisation', async () => {
      signIn = { password: false, credential: false, sso: ['Campus Login'] };
      await render();
      expect(findButton('Edit name')).toBeUndefined();
      expect(document.body.textContent).toContain("From your organisation's sign-in");
      expect(document.body.textContent).toContain('Managed by your organisation');
    });
  });

  describe('devices', () => {
    it('lists devices with this one marked, and signs another out', async () => {
      await render();
      await click(button('View Devices'));
      expect(api.get).toHaveBeenCalledWith('/me/sessions');
      const rows = [...document.querySelectorAll('[data-testid="account-session"]')];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain('Chrome on macOS');
      expect(rows[0]?.textContent).toContain('This device');
      expect(rows[0]?.querySelector('button')).toBeNull();
      // This device is in use as you read it (#98); others say when they were.
      expect(rows[0]?.textContent).toContain('Active now');
      expect(rows[1]?.textContent).toContain('Last active');
      expect(rows[1]?.textContent).toContain('Safari on iPhone');
      expect(rows[1]?.textContent).toContain('198.51.100.x');

      await click(rows[1]!.querySelector('button')!);
      expect(api.delete).toHaveBeenCalledWith('/me/sessions/s2');
      expect(dialog()?.textContent).toContain('That device has been signed out.');
    });

    it('signs out every other device', async () => {
      await render();
      await click(button('View Devices'));
      await click(button('Sign out all other devices'));
      expect(api.post).toHaveBeenCalledWith('/me/sessions/revoke-others');
      expect(dialog()?.textContent).toContain('1 other device has been signed out.');
    });
  });
});

describe('describeUserAgent', () => {
  it.each([
    [MAC_CHROME, 'Chrome on macOS'],
    [IPHONE_SAFARI, 'Safari on iPhone'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['curl/8.4.0', 'Unknown device'],
    [null, 'Unknown device'],
  ])('names %s', (userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toBe(expected);
  });
});
