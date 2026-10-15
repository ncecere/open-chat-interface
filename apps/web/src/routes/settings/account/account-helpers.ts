import { translate } from '~/lib/i18n';
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
      return translate('settings.account.errorInvalidPassword');
    case 'PASSWORD_TOO_SHORT':
      return translate('settings.account.passwordTooShort', { count: PASSWORD_MIN });
    case 'PASSWORD_TOO_LONG':
      return translate('settings.account.passwordTooLong', { count: PASSWORD_MAX });
    case 'LOCAL_AUTH_DISABLED':
      return translate('settings.account.localAuthDisabled');
    case 'PROFILE_MANAGED_BY_SSO':
      return translate('settings.account.nameFromSso');
    default:
      return error.message || fallback;
  }
}
