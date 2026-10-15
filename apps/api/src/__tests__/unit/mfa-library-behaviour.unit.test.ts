import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { secretFromUri, totp } from '../../../test/totp.js';
import { SoftwareAuthenticator } from '../../../test/webauthn.js';

/**
 * What OCI's MFA design (SPEC-mfa.md) rests on in Better Auth 1.6.26 and
 * @better-auth/passkey 1.6.26, settled by running it (the spec could only read
 * the code). A standalone instance on the in-memory adapter with the same plugin
 * options and hook shapes as apps/api/src/auth/index.ts, so a Better Auth
 * upgrade that changes any of this fails here first. The results are written up
 * in docs/dev/mfa-api.md ("Spike results").
 *
 * 1. `auth.api.*` calls made from OCI's own routes run Better Auth's hooks and
 *    can return the swapped session's Set-Cookie (`returnHeaders: true`).
 * 2. `context.path` is set for a session created inside such a call, so
 *    `session.create.before` can record how the session was made.
 * 3. A passkey assertion reports `userVerified`, so a PIN-less key can be refused.
 */
const origin = 'http://localhost:3000';
const password = 'Spike-password-0123456789';

type Seen = { hook: 'before' | 'after'; path: string };

function methodFor(path: string | undefined): string {
  switch (path) {
    case '/sign-in/email':
    case '/sign-up/email':
      return 'password';
    case '/two-factor/verify-totp':
      return 'totp';
    case '/two-factor/verify-backup-code':
      return 'recovery_code';
    case '/passkey/verify-authentication':
      return 'passkey';
    default:
      return path ? 'other' : 'unknown';
  }
}

function build(options: { refuseUnverifiedPasskey?: boolean } = {}) {
  const store: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
    passkey: [],
  };
  const hooks: Seen[] = [];
  const sessionPaths: Array<string | undefined> = [];
  const verified: boolean[] = [];

  const auth = betterAuth({
    baseURL: origin,
    basePath: '/api/auth',
    secret: 'spike-secret-with-at-least-32-characters',
    database: memoryAdapter(store),
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 12 },
    session: {
      cookieCache: { enabled: false },
      additionalFields: { authMethod: { type: 'string', required: false, input: false } },
    },
    advanced: { cookiePrefix: 'oci', database: { generateId: () => crypto.randomUUID() } },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            sessionPaths.push(context?.path);
            return { data: { ...session, authMethod: methodFor(context?.path) } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        hooks.push({ hook: 'before', path: ctx.path });
      }),
      after: createAuthMiddleware(async (ctx) => {
        hooks.push({ hook: 'after', path: ctx.path });
      }),
    },
    plugins: [
      twoFactor({ issuer: 'OCI spike' }),
      passkey({
        origin,
        rpID: 'localhost',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        authentication: {
          afterVerification: async ({ verification }) => {
            verified.push(verification.authenticationInfo.userVerified);
            if (options.refuseUnverifiedPasskey && !verification.authenticationInfo.userVerified) {
              const { APIError } = await import('better-auth/api');
              throw new APIError('UNAUTHORIZED', { code: 'USER_VERIFICATION_REQUIRED' });
            }
          },
        },
      }),
    ],
  });
  return { auth, store, hooks, sessionPaths, verified };
}

function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

function sessionToken(headers: Headers): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('oci.session_token='))
    ?.split(';')[0]
    ?.split('=')[1];
}

async function signUp(instance: ReturnType<typeof build>) {
  const email = `${crypto.randomUUID()}@example.test`;
  const { headers } = await instance.auth.api.signUpEmail({
    body: { email, password, name: 'Spike' },
    returnHeaders: true,
  });
  return { email, cookie: cookieHeader(headers) };
}

describe('Better Auth twoFactor: what OCI relies on', () => {
  it('runs hooks for auth.api calls, returns the swapped session Set-Cookie, and gives session.create a path', async () => {
    const instance = build();
    const { cookie } = await signUp(instance);
    expect(instance.sessionPaths).toEqual(['/sign-up/email']);

    const enabled = await instance.auth.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie }),
    });
    const secret = secretFromUri(enabled.totpURI);
    instance.hooks.length = 0;
    instance.sessionPaths.length = 0;

    const confirmed = await instance.auth.api.verifyTOTP({
      body: { code: totp(secret) },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });

    // 1. The hooks ran for a direct server-side call.
    expect(instance.hooks).toContainEqual({ hook: 'before', path: '/two-factor/verify-totp' });
    expect(instance.hooks).toContainEqual({ hook: 'after', path: '/two-factor/verify-totp' });
    // 1. The swapped session's cookie comes back in the returned headers.
    const swapped = sessionToken(confirmed.headers);
    expect(swapped).toBeTruthy();
    expect(swapped?.split('.')[0]).not.toBe(cookie.split('=')[1]?.split('.')[0]);
    // 2. The session created inside the call knew which endpoint made it.
    expect(instance.sessionPaths).toEqual(['/two-factor/verify-totp']);
    const sessions = instance.store.session as Array<{ authMethod?: string; token: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.authMethod).toBe('totp');
  });

  it('records the method for the sign-in with a second step and for disabling', async () => {
    const instance = build();
    const { email, cookie } = await signUp(instance);
    const enabled = await instance.auth.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie }),
    });
    const secret = secretFromUri(enabled.totpURI);
    await instance.auth.api.verifyTOTP({
      body: { code: totp(secret) },
      headers: new Headers({ cookie }),
    });
    instance.sessionPaths.length = 0;

    // The password step creates and then deletes a session; no session is left, and the hook saw `password`.
    const first = await instance.auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    expect(instance.sessionPaths).toEqual(['/sign-in/email']);
    expect((instance.store.session as unknown[]).length).toBe(1); // only the enrolment's session remains

    // The second step creates the session that counts.
    const challenge = cookieHeader(first.headers);
    expect(challenge).toContain('two_factor');
    const second = await instance.auth.handler(
      new Request(`${origin}/api/auth/two-factor/verify-totp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie: challenge },
        body: JSON.stringify({ code: totp(secret, { stepOffset: 1 }) }),
      }),
    );
    expect(second.status).toBe(200);
    expect(instance.sessionPaths.at(-1)).toBe('/two-factor/verify-totp');
    const methods = (instance.store.session as Array<{ authMethod?: string }>).map(
      (session) => session.authMethod,
    );
    expect(methods.at(-1)).toBe('totp');

    // Disabling swaps the session again, through an auth.api call, and says which endpoint did it.
    const signedIn = cookieHeader(second.headers);
    const disabled = await instance.auth.api.disableTwoFactor({
      body: { password },
      headers: new Headers({ cookie: signedIn }),
      returnHeaders: true,
    });
    expect(sessionToken(disabled.headers)).toBeTruthy();
    expect(instance.sessionPaths.at(-1)).toBe('/two-factor/disable');
  });

  it('accepts a code from the previous window twice (the plugin keeps no memory of used codes)', async () => {
    const instance = build();
    const { cookie } = await signUp(instance);
    const enabled = await instance.auth.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie }),
    });
    const secret = secretFromUri(enabled.totpURI);
    const confirmed = await instance.auth.api.verifyTOTP({
      body: { code: totp(secret) },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    // Confirming swapped the session; carry on with the new one.
    const signedIn = cookieHeader(confirmed.headers);
    const code = totp(secret);
    // Signed in, the same code verifies again and again: OCI's replay guard has to be ours.
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await instance.auth.api.verifyTOTP({
        body: { code },
        headers: new Headers({ cookie: signedIn }),
        returnHeaders: true,
      });
      expect(again.response).toBeTruthy();
    }
  });
});

describe('@better-auth/passkey: user verification', () => {
  async function registered(instance: ReturnType<typeof build>, userVerified: boolean) {
    const { cookie } = await signUp(instance);
    const optionsResponse = await instance.auth.api.generatePasskeyRegistrationOptions({
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    const authenticator = new SoftwareAuthenticator({ origin, rpId: 'localhost', userVerified });
    const registration = await instance.auth.api.verifyPasskeyRegistration({
      headers: new Headers({
        cookie: `${cookie}; ${cookieHeader(optionsResponse.headers)}`,
        origin,
      }),
      body: { response: authenticator.register(optionsResponse.response), name: 'Spike key' },
    });
    expect(registration).toMatchObject({ credentialID: authenticator.id });
    return authenticator;
  }

  async function signInWithPasskey(
    instance: ReturnType<typeof build>,
    authenticator: SoftwareAuthenticator,
  ) {
    const optionsResponse = await instance.auth.handler(
      new Request(`${origin}/api/auth/passkey/generate-authenticate-options`, {
        headers: { origin },
      }),
    );
    const options = await optionsResponse.json();
    return instance.auth.handler(
      new Request(`${origin}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          cookie: cookieHeader(optionsResponse.headers),
        },
        body: JSON.stringify({ response: authenticator.authenticate(options) }),
      }),
    );
  }

  it('reports userVerified in afterVerification and records the passkey method', async () => {
    const instance = build();
    const authenticator = await registered(instance, true);
    instance.sessionPaths.length = 0;
    const response = await signInWithPasskey(instance, authenticator);
    expect(response.status).toBe(200);
    expect(instance.verified).toEqual([true]);
    expect(instance.sessionPaths).toEqual(['/passkey/verify-authentication']);
    expect(sessionToken(response.headers)).toBeTruthy();
  });

  it('reports a PIN-less key as not verified, and the hook can refuse it before a session exists', async () => {
    const instance = build({ refuseUnverifiedPasskey: true });
    const authenticator = await registered(instance, false);
    instance.sessionPaths.length = 0;
    const response = await signInWithPasskey(instance, authenticator);
    expect(instance.verified).toEqual([false]);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' });
    expect(instance.sessionPaths).toEqual([]);
  });

  it('requires a fresh session to register a passkey', async () => {
    const instance = build();
    const { cookie } = await signUp(instance);
    // Age the session beyond freshAge (24 hours).
    for (const session of instance.store.session as Array<{ createdAt: Date }>) {
      session.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    }
    await expect(
      instance.auth.api.generatePasskeyRegistrationOptions({ headers: new Headers({ cookie }) }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: 'SESSION_NOT_FRESH' } });
  });
});
