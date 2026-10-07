/**
 * Where an email-verification link that did not work lands (#329).
 *
 * Better Auth answers a bad link by redirecting to the link's callback URL
 * with `?error=<code>`: `TOKEN_EXPIRED` after the hour, `INVALID_TOKEN` for
 * a damaged one, `USER_NOT_FOUND` when the account has gone. Every link this
 * app sends calls back to `/`, so that went to the chat home, whose guard
 * sent a signed-out visitor on to sign-in with the code buried in
 * `?redirect=`, and the page said nothing. The links already in people's
 * inboxes call back to `/` too, so the code is caught there rather than by
 * changing the callback.
 */
export const VERIFY_EMAIL_PAGE = '/auth/verify-email';

const VERIFY_LINK_ERRORS = new Set(['TOKEN_EXPIRED', 'INVALID_TOKEN', 'USER_NOT_FOUND']);

/** The code of a failed verification link arriving at `/`, or null. */
export function failedVerificationCode(pathname: string, searchStr: string): string | null {
  if (pathname !== '/') return null;
  const code = new URLSearchParams(searchStr).get('error');
  return code && VERIFY_LINK_ERRORS.has(code) ? code : null;
}

/** What the page says for a code. */
export function verifyLinkProblem(code: string | null): { title: string; message: string } {
  if (code === 'TOKEN_EXPIRED')
    return {
      title: 'Verification link expired',
      message: 'This verification link has expired: each link works for 1 hour.',
    };
  return {
    title: 'Verification link unavailable',
    message:
      'This verification link does not work. It may not have been copied in full, or the account may no longer exist.',
  };
}
