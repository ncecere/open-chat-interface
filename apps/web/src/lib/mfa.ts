import type { MfaStatus } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import type { FieldProblem } from '~/hooks/use-clear-on-edit';
import { ApiError, api, apiErrorProblems } from '~/lib/api-client';
import { signInUnavailable } from '~/lib/auth-unavailable';
import { translate } from '~/lib/i18n';
import { formatDate } from '~/lib/i18n/format';

/** What Settings → Account and the setup page read: `GET /api/me/mfa`. */
export const MFA_STATUS_KEY = ['me', 'mfa'] as const;

export function useMfaStatus() {
  return useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: () => api.get<MfaStatus>('/me/mfa'),
    retry: false,
  });
}

/**
 * An authenticator code as typed or pasted: "123 456" is 123456. Whitespace of
 * every kind goes (a pasted code often carries a no-break space); the server
 * ignores spaces too, so nothing here is the only check.
 */
export function authenticatorCode(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * A recovery code as typed or pasted. Case matters and the server adds a
 * missing hyphen to ten pasted characters, so only the edges are trimmed.
 */
export function recoveryCodeText(text: string): string {
  return text.trim();
}

/** The base32 key in groups of four, to read aloud and type by hand. */
export function groupManualKey(key: string): string {
  return key.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** Whether this browser can make and use passkeys (WebAuthn). */
export function webAuthnSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window;
}

/** "42 seconds", "15 minutes", "2 hours": a wait as a person would say it, in their language. */
export function retryText(seconds: number): string {
  if (seconds < 60)
    return translate('auth.retry.seconds', { count: Math.max(1, Math.ceil(seconds)) });
  if (seconds < 3600) return translate('auth.retry.minutes', { count: Math.ceil(seconds / 60) });
  return translate('auth.retry.hours', { count: Math.ceil(seconds / 3600) });
}

/** How long to wait, from a `Retry-After` in seconds, or "a minute" when the server gave none. */
const waitText = (retryAfter: number | null | undefined) =>
  retryAfter ? retryText(retryAfter) : translate('auth.retry.aMinute');

/** A deadline as a date in words, in the person's own time zone. */
export function mfaDeadlineText(iso: string): string {
  return formatDate(iso, 'long');
}

/** Better Auth's client error, with the `Retry-After` the wrapper read from the response. */
export interface SecondStepFailure {
  code?: string;
  message?: string;
  status?: number;
  /** Seconds, from the `Retry-After` header of a 429. */
  retryAfter?: number | null;
}

export interface SecondStepProblem {
  text: string;
  /**
   * The challenge is over: the next attempt cannot work, so the page offers to
   * start again instead of another try (an expired or unknown challenge, or
   * five wrong codes).
   */
  endsChallenge: boolean;
}

/** Fifteen minutes: how long ten wrong codes lock the second step (the API's setting). */
const LOCK_FALLBACK_SECONDS = 15 * 60;

/**
 * What to tell a person whose second step was refused, for every code the API
 * documents (docs/dev/mfa-api.md, section 1). An unknown and an expired
 * challenge give one error on purpose, so the wording covers both.
 */
export function secondStepProblem(
  failure: SecondStepFailure,
  method: 'totp' | 'recovery',
): SecondStepProblem {
  const keep = (text: string): SecondStepProblem => ({ text, endsChallenge: false });
  // The service failing (no answer, a 5xx) is not about the code (#288).
  if (typeof failure.status === 'number' && (failure.status === 0 || failure.status >= 500))
    return keep(signInUnavailable());
  switch (failure.code) {
    case 'INVALID_CODE':
      return keep(translate('auth.secondStep.invalidCode'));
    case 'INVALID_BACKUP_CODE':
      return keep(translate('auth.secondStep.invalidRecoveryCode'));
    case 'CODE_ALREADY_USED':
      return keep(
        translate(
          method === 'recovery' ? 'auth.secondStep.recoveryCodeUsed' : 'auth.secondStep.codeUsed',
        ),
      );
    case 'INVALID_TWO_FACTOR_COOKIE':
      return { text: translate('auth.secondStep.timedOut'), endsChallenge: true };
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
      return { text: translate('auth.secondStep.tooManyWrongCodes'), endsChallenge: true };
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return keep(
        translate('auth.secondStep.locked', {
          wait: retryText(failure.retryAfter || LOCK_FALLBACK_SECONDS),
        }),
      );
    case 'TOO_MANY_REQUESTS':
      return keep(
        translate('auth.secondStep.tooManyAttempts', { wait: waitText(failure.retryAfter) }),
      );
    default:
      return keep(failure.message || translate('auth.secondStep.generic'));
  }
}

export interface PasskeyProblem {
  /** A cancel is the person's own doing, said calmly; anything else is an error. */
  kind: 'cancelled' | 'error';
  text: string;
}

/**
 * What to tell a person whose passkey sign-in did not complete. The passkey
 * client reports anything the browser's prompt ended with (closing it, a
 * timeout, an abort) as a 400 whose code is `AUTH_CANCELLED` or one of
 * `@simplewebauthn/browser`'s `ERROR_…` codes; every other code is the server's.
 */
export function passkeyProblem(failure: SecondStepFailure): PasskeyProblem {
  const error = (text: string): PasskeyProblem => ({ kind: 'error', text });
  if (failure.code === 'AUTH_CANCELLED' || failure.code?.startsWith('ERROR_'))
    return { kind: 'cancelled', text: translate('auth.passkey.cancelledSignIn') };
  if (typeof failure.status === 'number' && (failure.status === 0 || failure.status >= 500))
    return error(signInUnavailable());
  switch (failure.code) {
    case 'LOCAL_AUTH_DISABLED':
      return error(translate('auth.passkey.localAuthDisabled'));
    case 'EMAIL_NOT_VERIFIED':
      return error(translate('auth.passkey.emailNotVerified'));
    case 'TOO_MANY_REQUESTS':
      return error(
        translate('auth.secondStep.tooManyAttempts', { wait: waitText(failure.retryAfter) }),
      );
    default:
      return error(failure.message || translate('auth.passkey.failed'));
  }
}

/**
 * The problems an `/api/me/mfa/*` refusal is about, each with its field. A wrong
 * password or code is a 422 whose details name the field and carry the whole
 * sentence ("Your password is not correct."), shown under that field as it is;
 * anything else (409, 429, a failure) is one problem about the whole attempt.
 */
export function mfaProblems(error: unknown, fallback: string): FieldProblem[] {
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const own = error.details.flatMap((raw: unknown): FieldProblem[] => {
      const issue = raw as { path?: unknown; message?: unknown } | null;
      const field = Array.isArray(issue?.path)
        ? issue.path.find((part): part is string => typeof part === 'string')
        : undefined;
      return field && typeof issue?.message === 'string' && issue.message
        ? [{ fields: [field], text: issue.message }]
        : [];
    });
    if (own.length > 0) return own;
  }
  return apiErrorProblems(error, fallback);
}

/**
 * The code to send for a step that takes either kind: six digits (spaces
 * tolerated) are an authenticator code; anything else is a recovery code, kept
 * as typed because case matters.
 */
export function currentCode(text: string): string {
  const compact = authenticatorCode(text);
  return /^\d{6}$/.test(compact) ? compact : recoveryCodeText(text);
}

/** What adding, renaming or removing a passkey said no with (the passkey client's errors). */
export function passkeyManageProblem(failure: SecondStepFailure): PasskeyProblem {
  const error = (text: string): PasskeyProblem => ({ kind: 'error', text });
  if (failure.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
    return error(translate('auth.passkey.alreadyRegistered'));
  if (failure.code === 'AUTH_CANCELLED' || failure.code?.startsWith('ERROR_'))
    return { kind: 'cancelled', text: translate('auth.passkey.cancelledManage') };
  if (typeof failure.status === 'number' && (failure.status === 0 || failure.status >= 500))
    return error(translate('auth.passkey.unavailable'));
  switch (failure.code) {
    case 'SESSION_NOT_FRESH':
      return error(translate('auth.passkey.sessionNotFresh'));
    case 'PASSKEY_NOT_AVAILABLE':
      return error(translate('auth.passkey.notAvailable'));
    case 'TOO_MANY_REQUESTS':
      return error(
        translate('auth.secondStep.tooManyAttempts', { wait: waitText(failure.retryAfter) }),
      );
    default:
      return error(failure.message || translate('auth.passkey.manageFailed'));
  }
}
