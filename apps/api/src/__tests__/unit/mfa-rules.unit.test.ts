import { describe, expect, it } from 'vitest';
import {
  authMethodFor,
  classifyCode,
  evaluateMfa,
  isSatisfiedSession,
  mfaDeadline,
  normaliseRecoveryCode,
  normaliseTotpCode,
} from '../../auth/mfa.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe('session auth method from the endpoint that created the session', () => {
  it.each([
    ['/sign-in/email', 'password'],
    ['/sign-up/email', 'password'],
    ['/two-factor/verify-totp', 'totp'],
    ['/two-factor/verify-backup-code', 'recovery_code'],
    ['/passkey/verify-authentication', 'passkey'],
    ['/sso/callback/campus-idp', 'sso'],
    ['/sso/callback', 'sso'],
    // Not a way in that proves anything about a second step.
    ['/verify-email', 'other'],
    ['/two-factor/disable', 'other'],
    ['/magic-link/verify', 'other'],
  ])('%s is %s', (path, method) => {
    expect(authMethodFor(path)).toBe(method);
  });

  it('is unknown (NULL, read as a password session) when no endpoint made the session', () => {
    expect(authMethodFor(undefined)).toBeNull();
    expect(authMethodFor(null)).toBeNull();
    expect(authMethodFor('')).toBeNull();
  });
});

describe('what people type', () => {
  it('ignores spaces and other white space inside an authenticator code', () => {
    expect(normaliseTotpCode('123 456')).toBe('123456');
    expect(normaliseTotpCode(' 123\u00a0456\n')).toBe('123456');
    expect(normaliseTotpCode('123456')).toBe('123456');
  });

  it('leaves everything else of an authenticator code alone, so a wrong code stays wrong', () => {
    expect(normaliseTotpCode('12-34-56')).toBe('12-34-56');
    expect(normaliseTotpCode('abc def')).toBe('abcdef');
  });

  it('trims a recovery code and adds the hyphen to ten pasted characters, nothing else', () => {
    expect(normaliseRecoveryCode('  abcde-FGH12 ')).toBe('abcde-FGH12');
    expect(normaliseRecoveryCode('abcdeFGH12')).toBe('abcde-FGH12');
    // Case is kept: the codes are case-sensitive.
    expect(normaliseRecoveryCode('ABCDEfgh12')).toBe('ABCDE-fgh12');
    // Not ten characters: left as typed (and refused by the check).
    expect(normaliseRecoveryCode('abcde fgh12')).toBe('abcde fgh12');
    expect(normaliseRecoveryCode('abc')).toBe('abc');
  });

  it('tells an authenticator code from a recovery code', () => {
    expect(classifyCode('123 456')).toBe('totp');
    expect(classifyCode('123456')).toBe('totp');
    expect(classifyCode('abcde-FGH12')).toBe('recovery_code');
    expect(classifyCode('abcdeFGH12')).toBe('recovery_code');
    expect(classifyCode('1234567890')).toBe('recovery_code');
    expect(classifyCode('12345')).toBe('recovery_code');
  });
});

describe('which sessions satisfy the requirement', () => {
  it('counts single sign-on and passkey sessions, with or without an authenticator', () => {
    expect(isSatisfiedSession('sso', false)).toBe(true);
    expect(isSatisfiedSession('passkey', false)).toBe(true);
    expect(isSatisfiedSession('passkey', true)).toBe(true);
  });

  it('counts a totp or recovery-code session only while the second step is still on', () => {
    expect(isSatisfiedSession('totp', true)).toBe(true);
    expect(isSatisfiedSession('recovery_code', true)).toBe(true);
    expect(isSatisfiedSession('totp', false)).toBe(false);
    expect(isSatisfiedSession('recovery_code', false)).toBe(false);
  });

  it('does not count a password, an unknown or an other session, nor a missing method', () => {
    for (const enabled of [true, false]) {
      expect(isSatisfiedSession('password', enabled)).toBe(false);
      expect(isSatisfiedSession('other', enabled)).toBe(false);
      expect(isSatisfiedSession(null, enabled)).toBe(false);
      expect(isSatisfiedSession(undefined, enabled)).toBe(false);
      expect(isSatisfiedSession('something-new', enabled)).toBe(false);
    }
  });
});

describe('the deadline', () => {
  const requirement = {
    roles: ['user' as const],
    graceDays: 14,
    since: { user: '2026-10-20T00:00:00.000Z' },
  };

  it('is the later of when the role was required and when the account was made, plus the grace', () => {
    // Account older than the requirement: the requirement's date counts.
    expect(
      mfaDeadline(requirement, 'user', new Date('2026-01-01T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-11-03T00:00:00.000Z');
    // Account made after the requirement: its own creation counts (a new person gets the grace too).
    expect(
      mfaDeadline(requirement, 'user', new Date('2026-10-30T00:00:00.000Z'))?.toISOString(),
    ).toBe('2026-11-13T00:00:00.000Z');
  });

  it('is null for a role that is not required', () => {
    expect(mfaDeadline(requirement, 'admin', new Date('2026-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('counts from the account alone when the role has no stamp (hand-edited settings)', () => {
    expect(
      mfaDeadline(
        { roles: ['user'], graceDays: 0, since: {} },
        'user',
        new Date('2026-05-05T00:00:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-05-05T00:00:00.000Z');
  });
});

describe('the decision', () => {
  const requirement = {
    roles: ['user' as const, 'admin' as const],
    graceDays: 14,
    since: { user: daysAgo(20).toISOString(), admin: daysAgo(20).toISOString() },
  };
  const base = {
    role: 'user' as const,
    authMethod: 'password' as string | null,
    twoFactorEnabled: false,
    accountCreatedAt: daysAgo(400),
    requirement,
    now,
  };

  it('limits a required role past the deadline on a password session, to enrol', () => {
    expect(evaluateMfa(base)).toMatchObject({
      required: true,
      satisfied: false,
      pastDeadline: true,
      candidate: true,
      reason: 'enrol',
    });
  });

  it('asks an enrolled person with a password session to sign in again with the second step', () => {
    expect(evaluateMfa({ ...base, twoFactorEnabled: true })).toMatchObject({
      candidate: true,
      reason: 'second_step',
    });
  });

  it('does not limit before the deadline, and reports it', () => {
    const result = evaluateMfa({
      ...base,
      requirement: { ...requirement, since: { user: daysAgo(3).toISOString() } },
    });
    expect(result.candidate).toBe(false);
    expect(result.required).toBe(true);
    expect(result.pastDeadline).toBe(false);
    expect(result.deadline?.toISOString()).toBe(
      new Date(daysAgo(3).getTime() + 14 * DAY).toISOString(),
    );
  });

  it('limits at once with a grace of 0', () => {
    expect(
      evaluateMfa({
        ...base,
        accountCreatedAt: daysAgo(1),
        requirement: { roles: ['user'], graceDays: 0, since: { user: daysAgo(1).toISOString() } },
      }).candidate,
    ).toBe(true);
  });

  it('does not limit a satisfied session', () => {
    for (const [authMethod, twoFactorEnabled] of [
      ['totp', true],
      ['recovery_code', true],
      ['passkey', false],
      ['sso', false],
    ] as const) {
      expect(evaluateMfa({ ...base, authMethod, twoFactorEnabled }).candidate).toBe(false);
    }
  });

  it('limits a totp session whose second step was switched off since', () => {
    expect(evaluateMfa({ ...base, authMethod: 'totp', twoFactorEnabled: false }).candidate).toBe(
      true,
    );
  });

  it('reads a missing method (an older session) as a password session', () => {
    expect(evaluateMfa({ ...base, authMethod: null }).candidate).toBe(true);
  });

  it('never limits a role that is not required', () => {
    const result = evaluateMfa({ ...base, role: 'restricted' });
    expect(result).toMatchObject({ required: false, candidate: false, deadline: null });
  });

  it('never limits anyone when nobody is required', () => {
    expect(
      evaluateMfa({ ...base, requirement: { roles: [], graceDays: 14, since: {} } }).candidate,
    ).toBe(false);
  });
});
