import { hashTag } from '../../lib/redis.js';

const KEY_PREFIX = 'oci:chat-stream';
/** Stream events kept per reply (approximately: Redis trims in whole nodes, never below it). */
export const MAX_EVENTS = 10_000;

/**
 * The keys of a reply. A run's keys share one hash tag (its id) and the
 * thread's pointer has its own, so on Redis Cluster each script touches one
 * slot; the two operations that touch both (publishing an admitted run and
 * finalizing one) run as two steps there. On one server or Sentinel the names
 * are those of every earlier release (`hashTag` adds no braces).
 */
export function chatStreamKeys(cluster: boolean) {
  const tag = (value: string) => hashTag(value, cluster ? 'cluster' : null);
  return {
    active: (threadId: string) => `${KEY_PREFIX}:thread:${tag(threadId)}:active`,
    metadata: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:metadata`,
    events: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:events`,
    snapshot: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:snapshot`,
    /** The producer's heartbeat (v0.11): present while the process writing the reply is alive. */
    alive: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:alive`,
  };
}

export const FINALIZE_RUN_SCRIPT = `
      if redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[1]
        or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2] then return 0 end
      redis.call('HSET', KEYS[1], 'status', ARGV[4])
      if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
      if ARGV[6] == '1' then redis.call('HSET', KEYS[1], 'replayUnavailable', '1') end
      if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
      redis.call('DEL', KEYS[3])
      return 1
    `;

export const DELETE_IF_EQUAL_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
