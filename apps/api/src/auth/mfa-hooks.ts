import { APIError, getSessionFromCtx } from 'better-auth/api';
import { claimCode, releaseCode } from '../services/limits/code-replay.js';
import { hasCredentialAccount } from '../services/mfa/credential.js';
import { normaliseRecoveryCode, normaliseTotpCode } from './mfa.js';

/**
 * Better Auth hooks for the second step (v0.14, #399), run for the plugin's
 * HTTP endpoints and for OCI's own server-side `auth.api.*` calls alike
 * (mfa-library-behaviour.unit.test.ts):
 *
 * - `verify-totp`: the code is cleaned (`123 456`), `trustDevice` is forced off
 *   (no "trust this device": a cookie nobody can list or revoke), and a code
 *   already accepted for the person in the last 120 seconds is refused before the
 *   plugin sees it (`code-replay.ts`); it is given back if the plugin refuses it.
 * - `verify-backup-code`: the code is cleaned, `trustDevice` forced off.
 * - passkey registration: only an account with a password may add one. A person
 *   who signs in through the organisation only would gain a local way around the
 *   identity provider.
 */
export interface MfaHookContext {
  path: string;
  body?: Record<string, unknown>;
  headers?: Headers;
  context: {
    secret: string;
    createAuthCookie(name: string): { name: string };
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null>;
    };
    /** Set by `mfaBefore` for `mfaAfter` and the audit entry. */
    mfaClaim?: { userId: string; code: string };
    /** Whose second step this request is for, so a refused code is audited against the person. */
    mfaActor?: string;
    returned?: unknown;
  };
  getSignedCookie(name: string, secret: string): Promise<string | null | undefined>;
}

/** The returned value of a failed request: an APIError carries `statusCode`, a Response `status`. */
export function statusOf(returned: unknown): number {
  const value = returned as { status?: unknown; statusCode?: unknown } | undefined;
  if (returned instanceof Response) return returned.status;
  return typeof value?.statusCode === 'number' ? value.statusCode : 200;
}

/** Whose code this is: the signed-in person, or the person the signed `two_factor` challenge was made for. */
export async function secondStepUserId(ctx: MfaHookContext): Promise<string | null> {
  const session = await getSessionFromCtx(ctx as never).catch(() => null);
  if (session?.user?.id) return session.user.id;
  const cookie = ctx.context.createAuthCookie('two_factor');
  const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!challenge) return null;
  const record = await ctx.context.internalAdapter.findVerificationValue(challenge);
  return record?.value ?? null;
}

export const CODE_ALREADY_USED_MESSAGE =
  'That code was just used. Wait for the next code on your authenticator and try again.';

export async function mfaBefore(
  ctx: MfaHookContext,
): Promise<{ context: Record<string, unknown> } | undefined> {
  if (ctx.path === '/two-factor/verify-backup-code') {
    const code = typeof ctx.body?.code === 'string' ? normaliseRecoveryCode(ctx.body.code) : '';
    const body = { ...ctx.body, code, trustDevice: false };
    const userId = code ? await secondStepUserId(ctx) : null;
    if (!userId) return { context: { body } };
    // One use each, also for two requests at once: the plugin's own guard does
    // not hold under concurrency (code-replay.ts). Given back if it is refused.
    const claimed = `recovery:${code}`;
    if (!(await claimCode(userId, claimed))) {
      throw new APIError('UNAUTHORIZED', {
        code: 'CODE_ALREADY_USED',
        message: CODE_ALREADY_USED_MESSAGE,
      });
    }
    return {
      context: { body, context: { mfaClaim: { userId, code: claimed }, mfaActor: userId } },
    };
  }

  if (ctx.path === '/two-factor/verify-totp') {
    const code = typeof ctx.body?.code === 'string' ? normaliseTotpCode(ctx.body.code) : '';
    const body = { ...ctx.body, code, trustDevice: false };
    const userId = code ? await secondStepUserId(ctx) : null;
    // No person (an unknown or expired challenge): the plugin answers that.
    if (!userId) return { context: { body } };
    if (!(await claimCode(userId, code))) {
      throw new APIError('UNAUTHORIZED', {
        code: 'CODE_ALREADY_USED',
        message: CODE_ALREADY_USED_MESSAGE,
      });
    }
    return { context: { body, context: { mfaClaim: { userId, code }, mfaActor: userId } } };
  }

  if (
    ctx.path === '/passkey/generate-register-options' ||
    ctx.path === '/passkey/verify-registration'
  ) {
    const session = await getSessionFromCtx(ctx as never).catch(() => null);
    // No session: the plugin answers 401.
    if (session?.user?.id && !(await hasCredentialAccount(session.user.id))) {
      throw new APIError('CONFLICT', {
        code: 'PASSKEY_NOT_AVAILABLE',
        message:
          'Your account signs in through your organisation, so a passkey cannot be added here.',
      });
    }
  }
  return undefined;
}

/** Gives back a replay claim whose code the plugin refused. */
export async function mfaAfter(ctx: MfaHookContext): Promise<void> {
  const claim = ctx.context.mfaClaim;
  if (!claim) return;
  if (statusOf(ctx.context.returned) >= 400) await releaseCode(claim.userId, claim.code);
}
