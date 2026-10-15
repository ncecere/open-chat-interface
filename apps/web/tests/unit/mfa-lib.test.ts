import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import {
  authenticatorCode,
  currentCode,
  groupManualKey,
  mfaDeadlineText,
  mfaProblems,
  passkeyManageProblem,
  passkeyProblem,
  recoveryCodeText,
  retryText,
  secondStepProblem,
} from '../../src/lib/mfa';

describe('the code a person types or pastes', () => {
  it('drops spaces from an authenticator code, wherever they are', () => {
    expect(authenticatorCode('123 456')).toBe('123456');
    expect(authenticatorCode('  123456  ')).toBe('123456');
    expect(authenticatorCode('1 2 3\u00a04 5 6')).toBe('123456');
    expect(authenticatorCode('123\t456\n')).toBe('123456');
  });

  it('keeps a recovery code as typed apart from the edges, because case matters', () => {
    expect(recoveryCodeText('  AbCde-fGh12 ')).toBe('AbCde-fGh12');
    expect(recoveryCodeText('AbCdefGh12')).toBe('AbCdefGh12');
  });
});

describe('the manual key', () => {
  it('is grouped in fours so it can be read and typed', () => {
    expect(groupManualKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupManualKey('ABCDEF')).toBe('ABCD EF');
  });
});

describe('how long to wait', () => {
  it('is in the unit a person would say', () => {
    expect(retryText(1)).toBe('1 second');
    expect(retryText(42)).toBe('42 seconds');
    expect(retryText(60)).toBe('1 minute');
    expect(retryText(61)).toBe('2 minutes');
    expect(retryText(900)).toBe('15 minutes');
    expect(retryText(7200)).toBe('2 hours');
  });
});

describe('the deadline', () => {
  it('is a date in words', () => {
    expect(mfaDeadlineText('2030-03-15T12:00:00.000Z')).toMatch(/March 1[45], 2030/);
  });
});

describe('what a refused second step says', () => {
  const problem = (code: string | undefined, method: 'totp' | 'recovery', extra = {}) =>
    secondStepProblem({ code, status: 401, ...extra }, method);

  it('says a wrong authenticator code is wrong, without ending the attempt', () => {
    const wrong = problem('INVALID_CODE', 'totp');
    expect(wrong.text).toBe(
      'That code is not right. Check the code in your authenticator app and try again.',
    );
    expect(wrong.endsChallenge).toBe(false);
  });

  it('says a wrong recovery code is wrong, and that case matters', () => {
    const wrong = problem('INVALID_BACKUP_CODE', 'recovery');
    expect(wrong.text).toContain('That recovery code is not right');
    expect(wrong.text).toContain('capital letters');
    expect(wrong.endsChallenge).toBe(false);
  });

  it('asks for the next code when the code was already used', () => {
    expect(problem('CODE_ALREADY_USED', 'totp').text).toBe(
      'That code was already used. Wait for the next code in your authenticator app, then enter it.',
    );
    expect(problem('CODE_ALREADY_USED', 'recovery').text).toContain(
      'recovery code was already used',
    );
    expect(problem('CODE_ALREADY_USED', 'totp').endsChallenge).toBe(false);
  });

  it('says to start again when the challenge is gone, unknown or expired alike', () => {
    const gone = problem('INVALID_TWO_FACTOR_COOKIE', 'totp');
    expect(gone.text).toContain('Start again');
    expect(gone.text).toContain('timed out');
    expect(gone.endsChallenge).toBe(true);
  });

  it('says to start again after five wrong codes', () => {
    const spent = secondStepProblem(
      { code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', status: 400 },
      'totp',
    );
    expect(spent.text).toContain('Too many wrong codes');
    expect(spent.text).toContain('Start again');
    expect(spent.endsChallenge).toBe(true);
  });

  it('says how long a locked second step stays locked', () => {
    const locked = secondStepProblem({ code: 'ACCOUNT_TEMPORARILY_LOCKED', status: 429 }, 'totp');
    expect(locked.text).toContain('locked');
    expect(locked.text).toContain('15 minutes');
    expect(locked.text).toContain('administrator');
    expect(locked.endsChallenge).toBe(false);

    const sooner = secondStepProblem(
      { code: 'ACCOUNT_TEMPORARILY_LOCKED', status: 429, retryAfter: 240 },
      'totp',
    );
    expect(sooner.text).toContain('4 minutes');
    expect(sooner.text).not.toContain('15 minutes');
  });

  it('says how long to wait after a rate limit, from Retry-After', () => {
    const limited = secondStepProblem(
      { code: 'TOO_MANY_REQUESTS', status: 429, retryAfter: 30 },
      'totp',
    );
    expect(limited.text).toBe('Too many attempts. Try again in 30 seconds.');
    const noHeader = secondStepProblem({ code: 'TOO_MANY_REQUESTS', status: 429 }, 'totp');
    expect(noHeader.text).toBe('Too many attempts. Try again in a minute.');
  });

  it('does not word the service failing as a wrong code', () => {
    expect(secondStepProblem({ status: 502 }, 'totp').text).toBe(
      'Sign-in is temporarily unavailable. Try again in a moment.',
    );
    expect(secondStepProblem({ status: 0 }, 'recovery').endsChallenge).toBe(false);
  });

  it("keeps the server's reason for a refusal it has no wording for", () => {
    expect(
      secondStepProblem(
        { code: 'BANNED_USER', status: 403, message: 'You have been banned.' },
        'totp',
      ).text,
    ).toBe('You have been banned.');
    expect(secondStepProblem({ status: 400 }, 'totp').text).toBe(
      'The code could not be checked. Try again.',
    );
  });
});

describe('what a refused passkey says', () => {
  it('treats the person closing the browser prompt as a cancel, not a failure', () => {
    for (const code of [
      'AUTH_CANCELLED',
      'ERROR_CEREMONY_ABORTED',
      'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
    ]) {
      const cancelled = passkeyProblem({ code, status: 400, message: 'auth cancelled' });
      expect(cancelled.kind).toBe('cancelled');
      expect(cancelled.text).toBe(
        'The passkey request was cancelled or timed out. Try again, or sign in another way.',
      );
    }
  });

  it('explains the instance refusing passkeys with its local rules', () => {
    expect(passkeyProblem({ code: 'LOCAL_AUTH_DISABLED', status: 403 }).text).toContain(
      'Email and password sign-in is turned off',
    );
    expect(passkeyProblem({ code: 'EMAIL_NOT_VERIFIED', status: 403 }).text).toContain(
      'not verified',
    );
  });

  it('says how long to wait after a rate limit, and does not blame the passkey for an outage', () => {
    expect(passkeyProblem({ code: 'TOO_MANY_REQUESTS', status: 429, retryAfter: 90 }).text).toBe(
      'Too many attempts. Try again in 2 minutes.',
    );
    expect(passkeyProblem({ status: 503 }).text).toBe(
      'Sign-in is temporarily unavailable. Try again in a moment.',
    );
  });

  it("keeps the server's reason, or says the passkey could not be used", () => {
    expect(passkeyProblem({ code: 'BANNED_USER', status: 403, message: 'Banned.' })).toEqual({
      kind: 'error',
      text: 'Banned.',
    });
    expect(passkeyProblem({ status: 401 }).text).toBe(
      'That passkey could not be used. Try again, or sign in with your password.',
    );
  });
});

describe('the code for a step that takes either kind', () => {
  it('sends six digits without their spaces, and anything else as typed', () => {
    expect(currentCode('123 456')).toBe('123456');
    expect(currentCode(' 123456 ')).toBe('123456');
    expect(currentCode(' aB3dE-fG5hJ ')).toBe('aB3dE-fG5hJ');
    expect(currentCode('1234567')).toBe('1234567');
  });
});

describe('the problems a refused MFA request is about', () => {
  it('puts a wrong password or code at its field, whole', () => {
    const refused = new ApiError(422, 'VALIDATION_FAILED', 'Your password is not correct.', [
      { path: ['password'], message: 'Your password is not correct.' },
    ]);
    expect(mfaProblems(refused, 'x')).toEqual([
      { fields: ['password'], text: 'Your password is not correct.' },
    ]);
  });

  it('is one problem about the whole attempt for anything else', () => {
    expect(mfaProblems(new ApiError(409, 'CONFLICT', 'Already on.'), 'x')).toEqual([
      { fields: [], text: 'Already on.' },
    ]);
    expect(mfaProblems(new TypeError('Failed to fetch'), 'It failed.')).toEqual([
      { fields: [], text: 'It failed.' },
    ]);
  });
});

describe('what a refused passkey change says', () => {
  it('says to sign in again when the session is not recent enough', () => {
    expect(passkeyManageProblem({ code: 'SESSION_NOT_FRESH', status: 403 }).text).toContain(
      'sign in again',
    );
  });

  it('tells a cancel from a passkey this device already has', () => {
    expect(passkeyManageProblem({ code: 'ERROR_CEREMONY_ABORTED', status: 400 }).kind).toBe(
      'cancelled',
    );
    expect(
      passkeyManageProblem({ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', status: 400 }).kind,
    ).toBe('error');
  });
});
