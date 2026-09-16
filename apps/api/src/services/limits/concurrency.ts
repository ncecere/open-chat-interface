import type { UserRole } from '@oci/shared';
import { logger } from '../../lib/logger.js';
import { sharedRedis } from '../chat-streams.js';
import { getRateLimitSettings } from '../lifecycle/settings.js';

const KEY_PREFIX = 'oci:concurrency';

/**
 * How long a slot survives without being released. A process that dies
 * mid-stream never releases its slot, so without expiry a crash would
 * permanently consume one of the user's allowed generations.
 */
const SLOT_TTL_SECONDS = 30 * 60;

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
    if (slots.size >= limit) return null;
    slots.add(runId);
    localSlots.set(key, slots);

    return {
      release: async () => {
        slots.delete(runId);
        if (slots.size === 0) localSlots.delete(key);
      },
    };
  }

  try {
    // Drop expired members first so a crashed replica cannot hold a slot past
    // the TTL, then count what genuinely remains live.
    const [, countResult] = await redis
      .multi()
      .zremrangebyscore(key, 0, now)
      .zcard(key)
      .exec()
      .then((results) => results ?? []);

    const active = Number(countResult?.[1] ?? 0);
    if (active >= limit) return null;

    await redis
      .multi()
      .zadd(key, now + SLOT_TTL_SECONDS * 1000, runId)
      .expire(key, SLOT_TTL_SECONDS)
      .exec();

    return {
      release: async () => {
        await redis.zrem(key, runId).catch(() => undefined);
      },
    };
  } catch (error) {
    // Availability beats strictness here: refusing every generation because
    // Redis blipped would be a worse failure than briefly not enforcing.
    logger.warn({ error, userId }, 'Concurrency cap unavailable; allowing the run');
    return { release: async () => undefined };
  }
}

export function resetLocalConcurrency(): void {
  localSlots.clear();
}
