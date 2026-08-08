import type { UserRole } from '@oci/shared';
import { logger } from '../../lib/logger.js';
import { sharedRedis } from '../chat-streams.js';
import { getRateLimitSettings } from '../lifecycle/settings.js';

const KEY_PREFIX = 'oci:limit';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window rolls over, for the Retry-After header. */
  retryAfterSeconds: number;
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
  };
}

export async function chatRateLimit(userId: string, role: UserRole): Promise<RateLimitResult> {
  const settings = await getRateLimitSettings();
  return consumeRateLimit({
    bucket: 'chat',
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
 * Limits an authentication attempt by IP and, when known, by the account being
 * targeted. Both are needed: an attacker controls the account field, so an
 * account-only limit is trivially evaded, while an IP-only limit lets a
 * distributed attempt through.
 */
export async function authRateLimit(params: {
  ipAddress: string | null;
  identifier?: string | null;
}): Promise<RateLimitResult> {
  const settings = await getRateLimitSettings();
  const limit = settings.authAttemptsPerMinute;

  const results = await Promise.all([
    consumeRateLimit({ bucket: 'auth:ip', identifier: params.ipAddress ?? 'unknown', limit }),
    ...(params.identifier
      ? [
          consumeRateLimit({
            bucket: 'auth:id',
            identifier: params.identifier.toLowerCase(),
            limit,
          }),
        ]
      : []),
  ]);

  // The tightest of the applicable limits wins.
  return results.reduce((strictest, result) =>
    !result.allowed || result.remaining < strictest.remaining ? result : strictest,
  );
}

/** Clears counters between tests. */
export function resetLocalRateLimits(): void {
  localCounters.clear();
}
