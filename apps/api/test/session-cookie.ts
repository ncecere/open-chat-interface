import { makeSignature } from 'better-auth/crypto';

/**
 * A signed session cookie value as Better Auth sets it (`token.signature`,
 * URL-encoded), for tests that create a session row directly (a single
 * sign-on session, say) and need a browser to carry it.
 */
export async function signCookieValue(secret: string, value: string): Promise<string> {
  return encodeURIComponent(`${value}.${await makeSignature(value, secret)}`);
}
