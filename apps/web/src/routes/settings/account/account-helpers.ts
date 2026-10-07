import { authReadOnlyRefusal, readOnlyMessage } from '~/lib/read-only';

/** The instance's password rules (Better Auth `emailAndPassword`). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
export const SESSIONS_KEY = ['me', 'sessions'] as const;

/** Better Auth's client returns errors rather than throwing them. */
export interface AuthResult {
  error?: { code?: string; message?: string; status?: number } | null;
}

export function authErrorMessage(result: AuthResult, fallback: string): string | null {
  const error = result.error;
  if (!error) return null;
  // Read-only maintenance: its reason and expected end, not "Try again",
  // which cannot work until it is over (#159).
  const readOnly = authReadOnlyRefusal(error);
  if (readOnly) return readOnlyMessage(readOnly);
  switch (error.code) {
    case 'INVALID_PASSWORD':
      return 'Your current password is not correct.';
    case 'PASSWORD_TOO_SHORT':
      return `Your new password must be at least ${PASSWORD_MIN} characters.`;
    case 'PASSWORD_TOO_LONG':
      return `Your new password must be at most ${PASSWORD_MAX} characters.`;
    case 'LOCAL_AUTH_DISABLED':
      return 'Email and password sign-in is turned off on this instance.';
    case 'PROFILE_MANAGED_BY_SSO':
      return "Your name comes from your organisation's sign-in.";
    default:
      return error.message || fallback;
  }
}
