import { loadEnv } from '../../config/env.js';
import { instanceId } from '../../lib/instance.js';
import { logger } from '../../lib/logger.js';
import { createRedisClient, redisMode } from '../../lib/redis.js';
import { sharedRedisClient } from '../chat-streams.js';
import { registerCollectedGauge } from '../observability/metrics.js';
import { getDefaultOrganizationId } from '../organization.js';

/**
 * Cross-replica cache invalidation (v0.11 design, item 20).
 *
 * Each replica keeps a few things it reads on nearly every request in memory
 * (settings, the connector catalogue, webhook endpoints). A change made on one
 * replica clears that replica's copy at once; this tells every other replica
 * to clear theirs too, over Redis pub/sub:
 *
 * - **One channel per instance**: `oci:cache-invalidate:<organization id>`,
 *   so two deployments sharing one Redis do not clear each other's caches.
 * - **A dedicated subscriber connection** per replica (a connection in
 *   subscriber mode can run no other command), built by the one Redis client
 *   factory, so Sentinel and Cluster work as for everything else. In Redis
 *   Cluster, PUBLISH reaches subscribers on every node (classic, not sharded,
 *   pub/sub), and ioredis moves the subscription to another node when one
 *   fails.
 * - **Publishing** uses the shared command connection, after the change is
 *   committed. A replica ignores its own messages (its copy is already fresh).
 * - **Messages missed while disconnected** cannot be replayed (pub/sub keeps
 *   nothing), so a subscriber that (re)subscribes after having been away
 *   clears every registered cache.
 *
 * **Fallback.** Caches keep their expiry (30 s for settings), so without Redis,
 * or while it is away, a change still reaches every replica within it, as
 * before. Within one replica nothing changes: its own changes apply at once.
 */

export type CacheName = 'settings' | 'connectors' | 'webhooks' | 'usagePolicy';

interface Invalidation {
  cache: CacheName;
  /** One entry of the cache; absent clears all of it. */
  key?: string;
  /** The replica that made the change. */
  from: string;
}

export type CacheBusStatus = 'unconfigured' | 'connecting' | 'listening' | 'unavailable';

/** What clears each cache in this process, registered by the cache's owner. */
const handlers = new Map<CacheName, (key?: string) => void>();

let status: CacheBusStatus = 'unconfigured';
let channelName: string | null = null;
const counts = { published: 0, received: 0, publishFailures: 0 };

/**
 * Registers what clears `cache` in this process. Called once, at module
 * load, by the module that owns the cache; a later registration replaces it.
 */
export function onCacheInvalidation(cache: CacheName, clear: (key?: string) => void): void {
  handlers.set(cache, clear);
}

function clearLocally(cache: CacheName, key?: string): void {
  try {
    handlers.get(cache)?.(key);
  } catch (error) {
    logger.warn({ err: String(error), cache }, 'Clearing a cache failed');
  }
}

function clearEverything(): void {
  for (const cache of handlers.keys()) clearLocally(cache);
}

async function channel(): Promise<string> {
  channelName ??= `oci:cache-invalidate:${await getDefaultOrganizationId()}`;
  return channelName;
}

/**
 * Tells every other replica to clear `cache` (or one `key` of it). Call after
 * the change is committed and this replica's own copy is cleared or updated.
 * Never throws: without Redis the other replicas' copies expire on their own.
 */
export async function publishInvalidation(cache: CacheName, key?: string): Promise<void> {
  if (!redisMode(loadEnv())) return;
  try {
    const client = await sharedRedisClient();
    if (!client) {
      counts.publishFailures++;
      logger.debug({ cache, key }, 'Redis unavailable: other replicas see this change on expiry');
      return;
    }
    const message: Invalidation = {
      cache,
      ...(key === undefined ? {} : { key }),
      from: instanceId,
    };
    await client.publish(await channel(), JSON.stringify(message));
    counts.published++;
  } catch (error) {
    counts.publishFailures++;
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), cache, key },
      'Could not publish a cache invalidation; other replicas see the change on expiry',
    );
  }
}

/** Applies a message heard on the channel. Exported for tests. */
export function handleInvalidationMessage(raw: string): void {
  let message: Partial<Invalidation>;
  try {
    message = JSON.parse(raw) as Partial<Invalidation>;
  } catch {
    return;
  }
  if (message.from === instanceId) return;
  if (typeof message.cache !== 'string' || !handlers.has(message.cache as CacheName)) return;
  counts.received++;
  clearLocally(
    message.cache as CacheName,
    typeof message.key === 'string' ? message.key : undefined,
  );
}

/** Whether this replica hears invalidations now. */
export function cacheBusStatus(): CacheBusStatus {
  return status;
}

/** Counters for System health and tests. */
export function cacheBusCounts(): Readonly<typeof counts> {
  return { ...counts };
}

registerCollectedGauge(
  'oci_cache_invalidation_listening',
  'Whether this replica hears cache invalidations from the others over Redis (1) or relies on cache expiry (0).',
  [],
  async () => [{ value: status === 'listening' ? 1 : 0 }],
);

/**
 * Opens this replica's subscriber connection and keeps it subscribed. Every
 * replica role starts it (a worker reads settings too: the read-only switch
 * pauses its jobs). Returns a function that closes it.
 */
export async function startCacheBus(): Promise<() => Promise<void>> {
  const env = loadEnv();
  const client = createRedisClient(env);
  if (!client) {
    status = 'unconfigured';
    return async () => {};
  }
  const name = await channel();
  status = 'connecting';
  // Set when a subscription that was in place is lost with its connection.
  let missed = false;
  let stopped = false;

  const subscribe = () => {
    if (stopped) return;
    client.subscribe(name).then(
      () => {
        // Anything published while this replica was not subscribed is lost:
        // start again from the database rather than trust what was cached.
        if (missed) clearEverything();
        missed = false;
        status = 'listening';
      },
      (error: unknown) => {
        status = 'unavailable';
        logger.debug({ err: String(error) }, 'Cache invalidation subscribe failed; retrying');
      },
    );
  };

  client.on('error', () => undefined);
  client.on('message', (from: string, raw: string) => {
    if (from === name) handleInvalidationMessage(raw);
  });
  // Ready again after a reconnect (a restart or a Sentinel failover): the
  // subscription went with the old connection; subscribe again here rather
  // than through ioredis's own resubscription, so the caches are cleared.
  client.on('ready', subscribe);
  const lost = () => {
    if (stopped) return;
    if (status === 'listening') missed = true;
    status = 'unavailable';
  };
  client.on('close', lost);
  client.on('end', lost);

  // Connects in the background; until it does, caches expire as before.
  client.connect().catch((error: unknown) => {
    if (!stopped) status = 'unavailable';
    logger.debug({ err: String(error) }, 'Cache invalidation connection failed; retrying');
  });

  return async () => {
    stopped = true;
    status = 'unconfigured';
    await client.quit().catch(() => client.disconnect());
  };
}

/**
 * System health's row for this replica (each replica answers for itself):
 * a warning while Redis is configured but this replica does not hear
 * invalidations, since other replicas' changes then reach it only on expiry.
 */
export async function cacheBusHealthCheck(): Promise<{
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}> {
  const base = { id: 'cache-invalidation', label: 'Cache invalidation' };
  if (status === 'listening')
    return {
      ...base,
      status: 'ok',
      detail: 'Changes made on any replica apply on this one at once (Redis pub/sub).',
    };
  if (status === 'unconfigured')
    return {
      ...base,
      status: 'ok',
      detail:
        'Redis is not configured: changes apply at once on this replica; other replicas see them within 30 seconds.',
    };
  return {
    ...base,
    status: 'warn',
    detail:
      'Not connected to Redis: changes made on other replicas reach this one within 30 seconds instead of at once.',
  };
}
