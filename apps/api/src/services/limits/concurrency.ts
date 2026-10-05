import type { UserRole } from '@oci/shared';
import { logger } from '../../lib/logger.js';
import { noteRedisFailure, sharedRedis } from '../chat-streams.js';
import { getRateLimitSettings } from '../lifecycle/settings.js';

const KEY_PREFIX = 'oci:concurrency';

/**
 * How long a slot survives without being released. A process that dies
 * mid-stream never releases its slot, so without expiry a crash would
 * permanently consume one of the user's allowed generations.
 */
const SLOT_TTL_SECONDS = 30 * 60;

// The cap check and reservation must be atomic across replicas. A retry for an
// already-live run renews that member without consuming another slot.
const ACQUIRE_SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local runId = ARGV[3]
local ttl = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if not redis.call('ZSCORE', key, runId) and redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now + ttl * 1000, runId)
redis.call('EXPIRE', key, ttl)
return 1
`;

export interface ConcurrencySlot {
  release: () => Promise<void>;
}

function slotKey(userId: string): string {
  return `${KEY_PREFIX}:user:${userId}`;
}

const localSlots = new Map<string, Set<string>>();

/**
 * Reserves one concurrent-generation slot, or returns null when the user is
 * already at their role's cap.
 *
 * A quota answers how much may be consumed over a window and is settled after
 * the fact; this answers how many runs may be in flight at once. Without it a
 * user can open many simultaneous streams, each holding a provider connection
 * and a reservation, and exhaust the instance for everyone else.
 *
 * Slots are stored as a sorted set keyed by expiry so stale entries from
 * crashed processes are evicted on the next acquisition rather than requiring
 * their own sweep.
 */
export async function acquireStreamSlot(
  userId: string,
  role: UserRole,
  runId: string,
): Promise<ConcurrencySlot | null> {
  const settings = await getRateLimitSettings();
  const limit = settings.roles[role].maxConcurrentStreams;
  const key = slotKey(userId);
  const now = Date.now();
  const redis = await sharedRedis();

  if (!redis) {
    const slots = localSlots.get(key) ?? new Set<string>();
    if (!slots.has(runId) && slots.size >= limit) return null;
    slots.add(runId);
    localSlots.set(key, slots);

    return {
      release: async () => {
        slots.delete(runId);
        // A repeated release must not remove a newer set created for this user.
        if (slots.size === 0 && localSlots.get(key) === slots) localSlots.delete(key);
      },
    };
  }

  try {
    const acquired = await redis.eval(
      ACQUIRE_SLOT_SCRIPT,
      1,
      key,
      now,
      limit,
      runId,
      SLOT_TTL_SECONDS,
    );
    if (acquired !== 1) return null;

    return {
      release: async () => {
        await redis.zrem(key, runId).catch(() => undefined);
      },
    };
  } catch (error) {
    noteRedisFailure(error);
    // Availability beats strictness here: refusing every generation because
    // Redis blipped would be a worse failure than briefly not enforcing.
    logger.warn({ error, userId }, 'Concurrency cap unavailable; allowing the run');
    return { release: async () => undefined };
  }
}

export function resetLocalConcurrency(): void {
  localSlots.clear();
}
