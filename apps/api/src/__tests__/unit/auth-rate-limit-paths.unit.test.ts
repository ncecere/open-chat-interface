import { describe, expect, it } from 'vitest';
import { isRateLimitedAuthPath } from '../../middleware/auth-rate-limit.js';

describe('authentication rate limit: which Better Auth endpoints count', () => {
  it.each([
    ['POST', '/sign-in/email', true],
    ['POST', '/sign-up/email', true],
    ['POST', '/sign-in/sso', true],
    ['POST', '/request-password-reset', true],
    ['POST', '/forget-password', true],
    ['POST', '/reset-password', true],
    ['POST', '/send-verification-email', true],
    ['GET', '/verify-email', true],
    ['GET', '/reset-password/abc123', true],
    ['GET', '/get-session', false],
    ['POST', '/sign-out', false],
    ['GET', '/sign-in/email', false],
    ['POST', '/change-password', false],
    ['PUT', '/sign-in/email', false],
  ] as const)('%s %s: %s', (method, path, limited) => {
    expect(isRateLimitedAuthPath(method, path)).toBe(limited);
  });
});
