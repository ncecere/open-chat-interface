import { loadEnv } from '../config/env.js';
import { databaseReplicaCount } from '../db/replicas.js';
import { redisConfigured, sharedRedisClient } from '../services/chat-streams.js';
import { liveReplicas } from '../services/jobs/workers.js';
import { logger } from './logger.js';
import { redisMode } from './redis.js';

/**
 * Redis is required for more than one replica (v0.11 design, item 16, which
 * answers the design's open question: yes). Without it each replica keeps its
 * own rate limit and concurrency counters (so the effective limits are
 * multiplied by the replica count), a reply can be resumed only on the
 * replica writing it, and System health cannot list replicas. One replica
 * without Redis remains supported.
 */
export const REDIS_REQUIRED_MESSAGE =
  'replicas share this database but Redis is not configured. Redis is required for more than one replica: without it rate limits and concurrency caps count per replica (multiplied by the replica count), and a reply can only be resumed on the replica writing it. Set REDIS_URL, REDIS_SENTINELS or REDIS_CLUSTER_NODES on every replica.';

export interface RedisCheck {
  id: 'redis';
  label: 'Redis';
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

function describeMode(): string {
  const env = loadEnv();
  switch (redisMode(env)) {
    case 'sentinel':
      return `Sentinel, master "${env.REDIS_SENTINEL_NAME ?? 'mymaster'}"`;
    case 'cluster':
      return 'Redis Cluster';
    default:
      return 'one server';
  }
}

/** The System health row for Redis. */
export async function redisHealthCheck(): Promise<RedisCheck> {
  const base = { id: 'redis', label: 'Redis' } as const;
  if (!redisConfigured()) {
    const replicas = await databaseReplicaCount();
    if (replicas !== null && replicas > 1)
      return { ...base, status: 'error', detail: `${replicas} ${REDIS_REQUIRED_MESSAGE}` };
    return {
      ...base,
      status: 'warn',
      detail:
        'Not configured. Rate limits and streams are per-process: fine for one replica, required for more.',
    };
  }
  const client = await sharedRedisClient();
  if (!client)
    return {
      ...base,
      status: 'error',
      detail: `Configured (${describeMode()}) but not reachable. Rate limits and concurrency caps count per replica, and replies are not resumable, until it is back.`,
    };
  try {
    await client.ping();
    const replicas = await liveReplicas().catch(() => null);
    const seen = replicas ? `; ${replicas.length} replica${replicas.length === 1 ? '' : 's'}` : '';
    return { ...base, status: 'ok', detail: `Responding (${describeMode()}${seen})` };
  } catch (error) {
    logger.error({ error }, 'Admin health: Redis check failed');
    return {
      ...base,
      status: 'error',
      detail: `Configured (${describeMode()}) but not reachable`,
    };
  }
}

/**
 * Logs a warning, at startup (after replicas started together have
 * connected) and every ten minutes while it lasts, when several replicas
 * share the database without Redis.
 */
export function watchRedisRequirement(
  options: { firstCheckMs?: number; intervalMs?: number } = {},
) {
  if (redisConfigured()) return () => {};
  const check = async () => {
    const replicas = await databaseReplicaCount();
    if (replicas !== null && replicas > 1)
      logger.warn({ replicas }, `${replicas} ${REDIS_REQUIRED_MESSAGE}`);
  };
  const first = setTimeout(() => void check(), options.firstCheckMs ?? 30_000);
  const timer = setInterval(() => void check(), options.intervalMs ?? 10 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
