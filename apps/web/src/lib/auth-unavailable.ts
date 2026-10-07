/**
 * Auth requests the service could not answer (#288).
 *
 * Better Auth's client spreads the response body into its error and adds the
 * status. While the database is unreachable the API answers `500` (marked
 * retryable, its message nested under `error`), and while the API restarts
 * the proxy answers `502`; neither carries a top-level code or message, and
 * neither is about what the person typed. The sign-in page took them for a
 * wrong password, and the reset pages for a feature that is turned off.
 */

export const SIGN_IN_UNAVAILABLE = 'Sign-in is temporarily unavailable. Try again in a moment.';

export const PASSWORD_RESET_UNAVAILABLE =
  'Password reset is temporarily unavailable. Try again in a moment.';

/** Better Auth's client error, as the pages read it. */
export interface AuthClientError {
  code?: string;
  message?: string;
  status: number;
  statusText: string;
}

/**
 * The error for a request that got no answer at all (the connection failed
 * or broke off), which Better Auth's client throws rather than returns.
 */
export const NO_ANSWER: AuthClientError = { status: 0, statusText: 'No answer' };

/** A Better Auth client call that resolves with `NO_ANSWER` instead of throwing. */
export function answered<T>(call: Promise<T>): Promise<T | { data: null; error: AuthClientError }> {
  return call.catch(() => ({ data: null, error: NO_ANSWER }));
}

/** Whether an error is the service failing (no answer, or a 5xx), not a refusal. */
export function isServiceFailure(error: { status?: unknown } | null | undefined): boolean {
  const status = error?.status;
  return typeof status === 'number' && (status === 0 || status >= 500);
}
