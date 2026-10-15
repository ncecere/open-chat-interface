import { symmetricEncrypt } from 'better-auth/crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { countRecoveryCodes } = await import('../../auth/recovery-codes.js');
const { statusOf } = await import('../../auth/mfa-hooks.js');
const { mfaChangeEmail } = await import('../../services/mfa/notify.js');
const { manualKeyFrom } = await import('../../services/mfa/enrolment.js');
const { nextRequirement, requirementChanged } = await import('../../services/mfa/requirement.js');
const { normalizeMfaRequirement, normalizeAuthSettings } = await import(
  '../../services/settings.js'
);

const SECRET = 'a-secret-with-at-least-32-characters!!';

describe('recovery codes: only a count ever leaves', () => {
  it('counts what the plugin stored, whatever it stored', async () => {
    const stored = await symmetricEncrypt({
      key: SECRET,
      data: JSON.stringify(['aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff']),
    });
    expect(await countRecoveryCodes(SECRET, stored)).toBe(3);
    const none = await symmetricEncrypt({ key: SECRET, data: '[]' });
    expect(await countRecoveryCodes(SECRET, none)).toBe(0);
  });

  it('is null for a value that cannot be read: a changed secret, a damaged row, something else', async () => {
    const stored = await symmetricEncrypt({ key: SECRET, data: '["aaaaa-bbbbb"]' });
    expect(await countRecoveryCodes('another-secret-with-at-least-32-chars!', stored)).toBeNull();
    expect(await countRecoveryCodes(SECRET, 'not-decryptable')).toBeNull();
    const notAList = await symmetricEncrypt({ key: SECRET, data: '{"codes":1}' });
    expect(await countRecoveryCodes(SECRET, notAList)).toBeNull();
  });
});

describe('what a failed hook returned', () => {
  it('reads the status of an APIError, of a Response and of a success', () => {
    expect(statusOf({ statusCode: 401 })).toBe(401);
    expect(statusOf(new Response('', { status: 429 }))).toBe(429);
    expect(statusOf({ body: { ok: true } })).toBe(200);
    expect(statusOf(undefined)).toBe(200);
  });
});

describe('the emails about changes', () => {
  it.each([
    ['enabled', 'turned on'],
    ['disabled', 'turned off'],
    ['recovery_codes_regenerated', 'recovery codes were created'],
    ['recovery_code_used', 'A recovery code was used'],
    ['passkey_added', 'A passkey was added'],
    ['passkey_removed', 'A passkey was removed'],
    ['reset_by_administrator', 'reset by an administrator'],
  ] as const)('%s says what happened and what to do, in plain words', (change, words) => {
    const mail = mfaChangeEmail(change, 'Campus Chat', { remaining: 4 });
    expect(mail.subject).toContain('Campus Chat');
    expect(`${mail.subject} ${mail.text}`).toContain(words);
    expect(mail.text.length).toBeGreaterThan(40);
    // Never a link that signs somebody in, a key or a code.
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.text).not.toMatch(/otpauth|secret/i);
  });

  it('says how many recovery codes are left, singular and plural, and nothing when unknown', () => {
    expect(mfaChangeEmail('recovery_code_used', 'X', { remaining: 1 }).text).toContain(
      '1 recovery code left',
    );
    expect(mfaChangeEmail('recovery_code_used', 'X', { remaining: 0 }).text).toContain(
      '0 recovery codes left',
    );
    expect(mfaChangeEmail('recovery_code_used', 'X', { remaining: null }).text).not.toContain(
      'left',
    );
  });
});

describe('the key to type by hand', () => {
  it('is the secret of the link, and empty without one', () => {
    expect(
      manualKeyFrom('otpauth://totp/Issuer:me%40example.test?secret=ABCDEF234567&issuer=Issuer'),
    ).toBe('ABCDEF234567');
    expect(manualKeyFrom('otpauth://totp/Issuer:me?issuer=Issuer')).toBe('');
  });
});

describe('the stored requirement', () => {
  it('reads nothing stored as nobody with the default grace', () => {
    expect(normalizeMfaRequirement(undefined)).toEqual({ roles: [], graceDays: 14, since: {} });
    expect(normalizeAuthSettings({} as never).mfaRequirement).toEqual({
      roles: [],
      graceDays: 14,
      since: {},
    });
  });

  it('drops what is malformed: unknown roles, a bad grace, a stamp that is not a date, a stamp for a role not required', () => {
    expect(
      normalizeMfaRequirement({
        roles: ['user', 'owner', 'admin'] as never,
        graceDays: -3,
        since: {
          user: 'yesterday',
          admin: '2026-01-01T00:00:00.000Z',
          restricted: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).toEqual({
      roles: ['admin', 'user'],
      graceDays: 14,
      since: { admin: '2026-01-01T00:00:00.000Z' },
    });
    expect(normalizeMfaRequirement({ roles: 'user' as never, graceDays: 2.5 })).toEqual({
      roles: [],
      graceDays: 14,
      since: {},
    });
    expect(normalizeMfaRequirement({ roles: ['user'], graceDays: 0, since: {} }).graceDays).toBe(0);
  });
});

describe('what saving a requirement makes of the stored one', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const stored = {
    roles: ['user' as const],
    graceDays: 14,
    since: { user: '2026-10-01T00:00:00.000Z' },
  };

  it('notices a change of roles or grace, and an unchanged save', () => {
    expect(requirementChanged(stored, { roles: ['user'], graceDays: 14 })).toBe(false);
    expect(requirementChanged(stored, { roles: ['user'], graceDays: 7 })).toBe(true);
    expect(requirementChanged(stored, { roles: ['user', 'admin'], graceDays: 14 })).toBe(true);
    expect(requirementChanged(stored, { roles: [], graceDays: 14 })).toBe(true);
  });

  it('keeps a stamp, stamps what is added now, orders roles, and forgets what is removed', () => {
    const next = nextRequirement(stored, { roles: ['restricted', 'user'], graceDays: 30 }, now);
    expect(next.roles).toEqual(['user', 'restricted']);
    expect(next.graceDays).toBe(30);
    expect(next.since).toEqual({ user: '2026-10-01T00:00:00.000Z', restricted: now.toISOString() });
    expect(nextRequirement(next, { roles: [], graceDays: 30 }, now)).toEqual({
      roles: [],
      graceDays: 30,
      since: {},
    });
  });

  it('re-stamps a kept role whose stamp is missing or not a date', () => {
    const broken = { roles: ['user' as const], graceDays: 14, since: { user: 'nonsense' } };
    expect(nextRequirement(broken, { roles: ['user'], graceDays: 14 }, now).since.user).toBe(
      now.toISOString(),
    );
  });
});
