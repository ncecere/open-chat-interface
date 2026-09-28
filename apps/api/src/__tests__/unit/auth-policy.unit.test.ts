import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: null as string | null,
  emailVerified: false,
  settings: {
    registrationMode: 'open' as 'open' | 'invite_only' | 'closed',
    emailVerificationRequired: false as unknown,
    localAuthEnabled: true,
  },
  smtpUsable: true,
  settingsError: null as Error | null,
}));

vi.mock('../../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            mocks.role ? [{ role: mocks.role, emailVerified: mocks.emailVerified }] : [],
        }),
      }),
    }),
  },
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: async () => {
    if (mocks.settingsError) throw mocks.settingsError;
    return mocks.settings;
  },
}));

vi.mock('../../services/email.js', () => ({
  isSmtpUsable: async () => mocks.smtpUsable,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import { enforceAuthRequestPolicy, isEmailVerificationEnforced } from '../../auth/policy.js';

describe('dynamic auth request policy', () => {
  beforeEach(() => {
    mocks.role = null;
    mocks.emailVerified = false;
    mocks.settings = {
      registrationMode: 'open',
      emailVerificationRequired: false,
      localAuthEnabled: true,
    };
    mocks.smtpUsable = true;
    mocks.settingsError = null;
  });

  it('fails closed when verification policy cannot be read', async () => {
    mocks.settingsError = new Error('Settings unavailable');
    await expect(isEmailVerificationEnforced()).rejects.toMatchObject({
      status: 'SERVICE_UNAVAILABLE',
      body: { code: 'AUTH_POLICY_UNAVAILABLE' },
    });
  });

  it.each([undefined, null, 0, 'false'])(
    'does not treat invalid verification value %s as disabled',
    async (value) => {
      mocks.settings.emailVerificationRequired = value;
      await expect(isEmailVerificationEnforced()).rejects.toMatchObject({
        status: 'SERVICE_UNAVAILABLE',
      });
      await expect(
        enforceAuthRequestPolicy('/sign-up/email', { email: 'person@example.com' }),
      ).rejects.toMatchObject({ status: 'SERVICE_UNAVAILABLE' });
      mocks.role = 'admin';
      mocks.emailVerified = true;
      await expect(
        enforceAuthRequestPolicy('/sign-in/email', { email: 'admin@example.com' }),
      ).resolves.toEqual({ requireEmailVerification: false });
    },
  );

  it('preserves only verified administrator recovery when settings are unavailable', async () => {
    mocks.settingsError = new Error('Settings unavailable');
    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'person@example.com' }),
    ).rejects.toMatchObject({ status: 'SERVICE_UNAVAILABLE' });

    mocks.role = 'admin';
    mocks.emailVerified = true;
    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'admin@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: false });
  });

  it('does not change SSO authentication policy', async () => {
    await expect(enforceAuthRequestPolicy('/sign-in/sso', undefined)).resolves.toBeNull();
  });

  it('checks resend policy availability without requiring a session or an existing account', async () => {
    await expect(
      enforceAuthRequestPolicy('/send-verification-email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: false });
    mocks.settingsError = new Error('Settings unavailable');
    await expect(
      enforceAuthRequestPolicy('/send-verification-email', { email: 'person@example.com' }),
    ).rejects.toMatchObject({ status: 'SERVICE_UNAVAILABLE' });
  });

  it.each(['invite_only', 'closed'] as const)('blocks public sign-up in %s mode', async (mode) => {
    mocks.settings.registrationMode = mode;
    await expect(
      enforceAuthRequestPolicy('/sign-up/email', { email: 'person@example.com' }),
    ).rejects.toThrow(mode === 'invite_only' ? 'valid invitation' : 'registration is closed');
  });

  it('blocks public sign-up and ordinary sign-in when local auth is disabled', async () => {
    mocks.settings.localAuthEnabled = false;
    await expect(
      enforceAuthRequestPolicy('/sign-up/email', { email: 'person@example.com' }),
    ).rejects.toThrow('disabled');
    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'person@example.com' }),
    ).rejects.toThrow('disabled');
  });

  it('keeps an administrator recovery sign-in available', async () => {
    mocks.settings.localAuthEnabled = false;
    mocks.settings.emailVerificationRequired = true;
    mocks.role = 'admin';
    mocks.emailVerified = true;

    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'admin@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: false });
  });

  it('does not treat an unverified newly-created admin as a recovery account', async () => {
    mocks.settings.localAuthEnabled = false;
    mocks.role = 'admin';

    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'admin@example.com' }),
    ).rejects.toThrow('disabled');
  });

  it('requires SDK verification without exposing account state before password validation', async () => {
    mocks.settings.emailVerificationRequired = true;
    mocks.role = 'user';
    mocks.emailVerified = false;

    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });

    mocks.emailVerified = true;
    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });
  });

  it('does not reveal unknown accounts when verification is enforced', async () => {
    mocks.settings.emailVerificationRequired = true;
    mocks.role = null;

    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'nobody@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });
  });

  it('requires verification independently of SMTP availability', async () => {
    mocks.settings.emailVerificationRequired = true;
    await expect(
      enforceAuthRequestPolicy('/sign-up/email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });

    mocks.smtpUsable = false;
    await expect(isEmailVerificationEnforced()).resolves.toBe(true);
    await expect(
      enforceAuthRequestPolicy('/sign-up/email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });
    mocks.role = 'user';
    await expect(
      enforceAuthRequestPolicy('/sign-in/email', { email: 'person@example.com' }),
    ).resolves.toEqual({ requireEmailVerification: true });
  });
});
