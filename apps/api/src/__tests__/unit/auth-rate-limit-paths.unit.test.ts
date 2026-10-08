import { describe, expect, it } from 'vitest';
import { authRequestKind, isRateLimitedAuthPath } from '../../middleware/auth-rate-limit.js';

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
    // Better Auth's own limiter covered these; it is off now (v0.11).
    ['POST', '/change-password', true],
    ['POST', '/change-email', true],
    ['GET', '/sso/callback/campus', true],
    // SAML sign-in was removed (#53); the path is answered 404 before any limiter.
    ['POST', '/sso/saml2/sp/acs/campus', false],
    ['GET', '/get-session', false],
    ['POST', '/sign-out', false],
    ['GET', '/sign-in/email', false],
    ['PUT', '/sign-in/email', false],
  ] as const)('%s %s: %s', (method, path, limited) => {
    expect(isRateLimitedAuthPath(method, path)).toBe(limited);
  });

  it('classifies each request for its limits', () => {
    expect(authRequestKind('POST', '/sign-in/email')).toEqual({
      kind: 'credential',
      provider: null,
    });
    expect(authRequestKind('POST', '/sign-up/email')).toEqual({ kind: 'request', provider: null });
    expect(authRequestKind('POST', '/change-password')).toEqual({
      kind: 'session',
      provider: null,
    });
    expect(authRequestKind('POST', '/sign-in/sso')).toEqual({ kind: 'sso-start', provider: null });
    expect(authRequestKind('GET', '/sso/callback/campus%20idp')).toEqual({
      kind: 'sso-callback',
      provider: 'campus idp',
    });
    expect(authRequestKind('POST', '/sso/saml2/callback/staff')).toBeNull();
    expect(authRequestKind('GET', '/sso/callback')).toEqual({
      kind: 'sso-callback',
      provider: '(shared callback)',
    });
  });
});
