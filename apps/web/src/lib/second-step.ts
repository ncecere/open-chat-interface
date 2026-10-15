import { authClient } from '~/lib/auth-client';
import { answered } from '~/lib/auth-unavailable';
import {
  authenticatorCode,
  recoveryCodeText,
  type SecondStepFailure,
  type SecondStepProblem,
  secondStepProblem,
} from '~/lib/mfa';

/**
 * What Better Auth's client call is given to learn the `Retry-After` of a 429:
 * its error object carries the body and the status but not the headers.
 */
export function retryAfterCapture() {
  const captured: { seconds: number | null } = { seconds: null };
  return {
    captured,
    fetchOptions: {
      onResponse: (context: { response?: Response }) => {
        const seconds = Number(context.response?.headers?.get('retry-after'));
        captured.seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      },
    },
  };
}

/** The failure of a Better Auth client call as the pages read it, with its Retry-After. */
export function failureOf(
  error: { code?: string; message?: string; status?: number },
  retryAfter: number | null,
): SecondStepFailure {
  return { code: error.code, message: error.message, status: error.status, retryAfter };
}

export type SecondStepResult = { ok: true } | { ok: false; problem: SecondStepProblem };

/**
 * The second step of a password sign-in: an authenticator code or a recovery
 * code, checked against the challenge cookie the password step set. Never sends
 * `trustDevice`: the server ignores it, there is no "trust this device".
 */
export async function verifySecondStep(
  method: 'totp' | 'recovery',
  typed: string,
): Promise<SecondStepResult> {
  const { captured, fetchOptions } = retryAfterCapture();
  const result = await answered(
    method === 'totp'
      ? authClient.twoFactor.verifyTotp({ code: authenticatorCode(typed), fetchOptions })
      : authClient.twoFactor.verifyBackupCode({ code: recoveryCodeText(typed), fetchOptions }),
  );
  if (result.error) {
    return {
      ok: false,
      problem: secondStepProblem(failureOf(result.error, captured.seconds), method),
    };
  }
  return { ok: true };
}
