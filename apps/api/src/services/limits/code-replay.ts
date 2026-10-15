import { createHash } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { noteRedisFailure, sharedRedis } from '../chat-streams.js';

/**
 * The replay guard for authenticator codes (SPEC-mfa.md, "Replay").
 *
 * Better Auth accepts a TOTP code for about 90 seconds (the current 30-second
 * window and one either side) and keeps no memory of the codes it accepted, so
 * a code seen once (shoulder-surfed, phished in real time, taken from a log)
 * could be used again inside that time. OCI remembers each code it lets
 * through for 120 seconds, a little longer than the plugin would accept it.
 *
 * It is claimed before the plugin checks it, with one atomic `SET NX EX` in the
 * Redis every replica shares (two replicas racing on the same code give one
 * winner: mfa-redis-primitives.integration.test.ts), and given back when the
 * plugin refuses the code, so a typing mistake is not a replay. Only a hash of
 * the person and the code is stored. With Redis away it counts in this process,
 * as the rate limits do: weaker with several replicas, never none.
 */
export const CODE_REPLAY_SECONDS = 120;

const KEY_PREFIX = 'oci:mfa-code';

const localClaims = new Map<string, number>();

function keyFor(userId: string, code: string): string {
  const digest = createHash('sha256').update(`${userId}:${code}`).digest('hex');
  return `${KEY_PREFIX}:${digest}`;
}

function localClaim(key: string): boolean {
  const now = Date.now();
  const until = localClaims.get(key);
  if (until !== undefined && until > now) return false;
  // Bounded cleanup so an idle process does not accumulate dead claims.
  if (localClaims.size > 10_000) {
    for (const [candidate, expires] of localClaims) {
      if (expires <= now) localClaims.delete(candidate);
    }
  }
  localClaims.set(key, now + CODE_REPLAY_SECONDS * 1000);
  return true;
}

/** True when this is the first use of the code for the person in the window; false for a replay. */
export async function claimTotpCode(userId: string, code: string): Promise<boolean> {
  const key = keyFor(userId, code);
  const redis = await sharedRedis();
  if (redis) {
    try {
      return (await redis.set(key, '1', 'EX', CODE_REPLAY_SECONDS, 'NX')) === 'OK';
    } catch (error) {
      noteRedisFailure(error);
      logger.warn({ error }, 'The code replay guard fell back to local memory');
    }
  }
  return localClaim(key);
}

/** Forgets a claim whose code the plugin refused. Never throws. */
export async function releaseTotpCode(userId: string, code: string): Promise<void> {
  const key = keyFor(userId, code);
  localClaims.delete(key);
  const redis = await sharedRedis();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (error) {
    noteRedisFailure(error);
  }
}

/** Clears this process's claims between tests. */
export function resetLocalCodeClaims(): void {
  localClaims.clear();
}
