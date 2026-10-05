import type { UserRole } from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { noteRedisFailure, sharedRedis } from '../chat-streams.js';
import { getRateLimitSettings } from '../lifecycle/settings.js';

const KEY_PREFIX = 'oci:limit';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window rolls over, for the Retry-After header. */
  retryAfterSeconds: number;
  /**
   * True only for the first refused request in a window, so a refusal can be
   * logged or audited once per window rather than once per request.
   */
  firstRefusal: boolean;
  /** The counter's key in this window, so an attempt can be refunded (`refundRateLimit`). */
  key?: string;
}

/**
 * In-process fallback used when Redis is unavailable.
 *
 * This is per replica, so with several replicas the effective limit is the
 * configured value times the replica count. That is weaker than intended but
 * strictly better than no limit, and production deployments are expected to
 * configure Redis.
 */
const localCounters = new Map<string, { count: number; resetAt: number }>();

function localIncrement(key: string, windowMs: number): number {
  const now = Date.now();
  const existing = localCounters.get(key);

  if (!existing || existing.resetAt <= now) {
    localCounters.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }

  existing.count += 1;

  // Bounded cleanup so an idle process does not accumulate dead windows.
  if (localCounters.size > 10_000) {
    for (const [candidate, value] of localCounters) {
      if (value.resetAt <= now) localCounters.delete(candidate);
    }
  }

  return existing.count;
}

/**
 * Counts one request against a fixed window.
 *
 * A fixed window can allow up to twice the limit across a boundary. That is
 * acceptable here: these limits exist to stop runaway automation, not to meter
 * billing, and the simpler primitive is far cheaper per request.
 */
export async function consumeRateLimit(params: {
  bucket: string;
  identifier: string;
  limit: number;
  windowSeconds?: number;
}): Promise<RateLimitResult> {
  const windowSeconds = params.windowSeconds ?? 60;
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `${KEY_PREFIX}:${params.bucket}:${params.identifier}:${windowStart}`;

  let count: number;
  const redis = await sharedRedis();

  if (redis) {
    try {
      const results = await redis.multi().incr(key).expire(key, windowSeconds).exec();
      count = Number(results?.[0]?.[1] ?? 1);
    } catch (error) {
      noteRedisFailure(error);
      logger.warn({ error, bucket: params.bucket }, 'Rate limit fell back to local counting');
      count = localIncrement(key, windowSeconds * 1000);
    }
  } else {
    count = localIncrement(key, windowSeconds * 1000);
  }

  const elapsed = Date.now() / 1000 - windowStart * windowSeconds;
  return {
    allowed: count <= params.limit,
    limit: params.limit,
    remaining: Math.max(0, params.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - elapsed)),
    firstRefusal: count === params.limit + 1,
    key,
  };
}

/**
 * Takes back one counted request, as if it had not been made: a successful
 * sign-in is not a failed attempt. Never below zero, and nothing happens once
 * the window (and so the key) has gone.
 */
const REFUND_SCRIPT = `
local count = tonumber(redis.call('get', KEYS[1]) or '0')
if count > 0 then return redis.call('decr', KEYS[1]) end
return 0
`;

export async function refundRateLimit(key: string): Promise<void> {
  const redis = await sharedRedis();
  if (redis) {
    try {
      await redis.eval(REFUND_SCRIPT, 1, key);
      return;
    } catch (error) {
      noteRedisFailure(error);
    }
  }
  const local = localCounters.get(key);
  if (local && local.count > 0) local.count -= 1;
}

export async function chatRateLimit(userId: string, role: UserRole): Promise<RateLimitResult> {
  const settings = await getRateLimitSettings();
  return consumeRateLimit({
    bucket: 'chat',
    identifier: userId,
    limit: settings.roles[role].chatRequestsPerMinute,
  });
}

/**
 * Starting a conversation (POST /api/threads, v0.10.2). Every new
 * conversation is followed by its first message, so the allowance is the
 * role's chat requests per minute, counted separately: a person who can send
 * N messages a minute can also start N conversations, and a client stuck in a
 * loop cannot create conversations without bound (v0.10.1 created 16,389 in
 * 20 seconds for one person).
 */
export async function threadCreateRateLimit(
  userId: string,
  role: UserRole,
): Promise<RateLimitResult> {
  const settings = await getRateLimitSettings();
  return consumeRateLimit({
    bucket: 'thread-create',
    identifier: userId,
    limit: settings.roles[role].chatRequestsPerMinute,
  });
}

export async function uploadRateLimit(userId: string, role: UserRole): Promise<RateLimitResult> {
  const settings = await getRateLimitSettings();
  return consumeRateLimit({
    bucket: 'upload',
    identifier: userId,
    limit: settings.roles[role].uploadRequestsPerMinute,
  });
}

/**
 * What an authentication request is, for its limits (v0.11 design, item 22;
 * docs/OPERATIONS.md, "Sign-in limits"):
 *
 * - `credential` (`/sign-in/email`): only **failed** attempts count, per
 *   account (`authAttemptsPerMinute`) and per address (the much larger
 *   `RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE`, since a campus NAT puts many
 *   people behind one address). Both are counted before the attempt (so a
 *   burst sent at once is still bounded) and refunded when it succeeds.
 * - `request` (sign-up, password reset, verification): every request counts,
 *   per account named and per address, with the same allowances.
 * - `session` (`/change-password`, `/change-email`): every request counts per
 *   session (the account's own credential is what is being tried).
 * - `sso-start` (`/sign-in/sso`): only the address ceiling.
 * - `sso-callback`: every callback counts against its identity provider's
 *   budget (`RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE`), so one misbehaving
 *   provider cannot starve the others; failed callbacks also count per
 *   address, refunded on success, so successful sign-ins are never limited
 *   by address.
 *
 * Every request from one address, of any kind and outcome, is also capped at
 * ten times the address allowance (the ceiling), against abuse. Checks run
 * in order (ceiling, provider, account or session, address) and stop at the
 * first refusal, so one person retrying a locked account does not use up the
 * failed attempts of everyone behind the same address.
 *
 * With no client address (no trusted proxy header and no socket), only the
 * account, session or provider is counted: one shared "unknown" counter
 * would let a single client lock everyone out.
 */
export type AuthRequestKind = 'credential' | 'request' | 'session' | 'sso-start' | 'sso-callback';

export type AuthLimitScope = 'ip' | 'ip-ceiling' | 'account' | 'session' | 'provider';

export interface AuthRateLimitResult extends RateLimitResult {
  scope: AuthLimitScope | null;
  /** Counter keys to refund if the attempt succeeds. */
  refundOnSuccess: string[];
}

/** Every request from one address is capped at this multiple of the address allowance. */
export const AUTH_ADDRESS_CEILING_FACTOR = 10;

interface AuthCheck {
  scope: AuthLimitScope;
  bucket: string;
  identifier: string;
  limit: number;
  refund: boolean;
}

export async function authRateLimit(params: {
  kind?: AuthRequestKind;
  ipAddress: string | null;
  /** The account (email) named in the request. */
  identifier?: string | null;
  /** A hash of the session token, for `session` requests. */
  session?: string | null;
  /** The identity provider, for `sso-callback` requests. */
  provider?: string | null;
}): Promise<AuthRateLimitResult> {
  const kind = params.kind ?? 'request';
  const settings = await getRateLimitSettings();
  const env = loadEnv();
  const accountLimit = settings.authAttemptsPerMinute;
  const addressLimit = env.RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE;
  const account = params.identifier?.trim().toLowerCase() || null;
  const ip = params.ipAddress;

  const checks: AuthCheck[] = [];
  if (ip)
    checks.push({
      scope: 'ip-ceiling',
      bucket: 'auth:ip-all',
      identifier: ip,
      limit: addressLimit * AUTH_ADDRESS_CEILING_FACTOR,
      refund: false,
    });
  if (kind === 'sso-callback' && params.provider)
    checks.push({
      scope: 'provider',
      bucket: 'auth:sso-provider',
      identifier: params.provider,
      limit: env.RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE,
      refund: false,
    });
  if (kind === 'credential' && account)
    checks.push({
      scope: 'account',
      bucket: 'auth:account-failed',
      identifier: account,
      limit: accountLimit,
      refund: true,
    });
  if (kind === 'request' && account)
    checks.push({
      scope: 'account',
      bucket: 'auth:id',
      identifier: account,
      limit: accountLimit,
      refund: false,
    });
  if (kind === 'session' && params.session)
    checks.push({
      scope: 'session',
      bucket: 'auth:session',
      identifier: params.session,
      limit: accountLimit,
      refund: false,
    });
  if (ip && (kind === 'credential' || kind === 'sso-callback'))
    checks.push({
      scope: 'ip',
      bucket: 'auth:ip-failed',
      identifier: ip,
      limit: addressLimit,
      refund: true,
    });
  if (ip && kind === 'request')
    checks.push({
      scope: 'ip',
      bucket: 'auth:ip',
      identifier: ip,
      limit: addressLimit,
      refund: false,
    });

  const refundOnSuccess: string[] = [];
  let tightest: (RateLimitResult & { scope: AuthLimitScope }) | null = null;
  for (const check of checks) {
    const result = await consumeRateLimit({
      bucket: check.bucket,
      identifier: check.identifier,
      limit: check.limit,
    });
    if (!result.allowed) {
      // Nothing to refund: a refused attempt never reaches Better Auth, and
      // the counters it did add stay counted, as every attempt is.
      return { ...result, scope: check.scope, refundOnSuccess: [] };
    }
    if (check.refund && result.key) refundOnSuccess.push(result.key);
    if (!tightest || result.remaining < tightest.remaining)
      tightest = { ...result, scope: check.scope };
  }
  if (!tightest) {
    return {
      allowed: true,
      limit: accountLimit,
      remaining: accountLimit,
      retryAfterSeconds: 0,
      firstRefusal: false,
      scope: null,
      refundOnSuccess,
    };
  }
  return { ...tightest, refundOnSuccess };
}

/** Clears counters between tests. */
export function resetLocalRateLimits(): void {
  localCounters.clear();
}
