import type Redis from 'ioredis';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  createRedisClient,
  isRedisReplyError,
  isRedisUnavailableError,
  type RedisClient,
  redisMode,
  redisReady,
} from '../../lib/redis.js';
import { ChatStreamStore } from './store.js';

/**
 * After an unexpected Redis failure (not a lost connection, which the client
 * reconnects by itself), Redis is left alone for this long, doubling on each
 * further failure up to `REDIS_MAX_RETRY_DELAY_MS`, then a new client is made.
 */
const REDIS_RETRY_DELAY_MS = 1_000;
const REDIS_MAX_RETRY_DELAY_MS = 30_000;
/** The longest the first use of Redis waits for a connection. */
const REDIS_FIRST_CONNECT_MS = 2_000;

let runtimeStore: ChatStreamStore | null = null;
export let redisClient: RedisClient | null = null;
let redisUnavailableUntil = 0;
let redisFailures = 0;
/** Whether Redis was ready the last time it was looked at, for logging changes only. */
let redisWasReady: boolean | null = null;

export function noteReadiness(ready: boolean, detail?: string) {
  if (redisWasReady === ready) return;
  // The first look at a working Redis says nothing; every change is logged.
  if (ready && redisWasReady !== null) logger.info('Redis is available again');
  if (!ready)
    logger.warn(
      { err: detail },
      'Redis unavailable: replies are not resumable, rate limits and concurrency caps count per replica, until it is back',
    );
  redisWasReady = ready;
}

/** Drops the current client after an unexpected failure; a new one is made after a pause. */
export function discardClient(error: unknown) {
  redisFailures++;
  redisUnavailableUntil =
    Date.now() +
    Math.min(REDIS_RETRY_DELAY_MS * 2 ** (redisFailures - 1), REDIS_MAX_RETRY_DELAY_MS);
  runtimeStore = null;
  redisClient?.disconnect();
  redisClient = null;
  noteReadiness(false, error instanceof Error ? error.message : String(error));
}

/**
 * The store on the shared client, or null while Redis is unconfigured or not
 * connected. The first use waits (briefly) for the connection; after that a
 * client that lost its connection reconnects in the background (to the new
 * primary, with Sentinel or Cluster) and this answers null without waiting
 * until it is back, so no request waits on Redis while it is away.
 */
export async function runtimeChatStreamStore(): Promise<ChatStreamStore | null> {
  const env = loadEnv();
  if (!redisMode(env) || Date.now() < redisUnavailableUntil) return null;
  // Callers arriving while the client's first connection is made wait for it.
  if (firstConnection) await firstConnection;
  if (runtimeStore && redisClient && redisClient.status !== 'end') {
    const ready = redisReady(redisClient);
    noteReadiness(ready);
    return ready ? runtimeStore : null;
  }

  const client = createRedisClient(env);
  if (!client) return null;
  client.on('error', () => undefined);
  redisClient = client;
  const store = new ChatStreamStore(client, env.CHAT_STREAM_TTL_SECONDS);
  runtimeStore = store;
  const connecting = connectFirst(client);
  firstConnection = connecting;
  const connected = await connecting.finally(() => {
    if (firstConnection === connecting) firstConnection = null;
  });
  if (connected === true && redisReady(client)) {
    redisFailures = 0;
    noteReadiness(true);
    return store;
  }
  noteReadiness(
    false,
    connected instanceof Error ? connected.message : 'Timed out connecting to Redis',
  );
  return null;
}

let firstConnection: Promise<unknown> | null = null;

/**
 * The first connection of a new client, bounded: with Sentinel, connect()
 * keeps asking the sentinels for as long as none answers. It goes on in the
 * background either way.
 */
async function connectFirst(client: RedisClient): Promise<true | false | Error> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    client.connect().then(
      () => true as const,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), REDIS_FIRST_CONNECT_MS);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The shared Redis connection, or null when Redis is unconfigured or down.
 *
 * Rate limiting and concurrency caps reuse this rather than opening a second
 * connection: they need the same availability signal, and a limiter that
 * silently used a different client could disagree about whether Redis works.
 *
 * With Redis Cluster this is a `Cluster` (typed as `Redis` for the callers
 * written before v0.11; it has the same commands). Keys used together in one
 * MULTI or script need a shared hash tag there (`hashTag`, lib/redis.ts).
 * `sharedRedisClient()` is the same client with its real type.
 */
export async function sharedRedis(): Promise<Redis | null> {
  return (await sharedRedisClient()) as Redis | null;
}

export async function sharedRedisClient(): Promise<RedisClient | null> {
  return (await runtimeChatStreamStore()) ? redisClient : null;
}

/**
 * How long a reader asking to resume a reply waits for a Redis client that is
 * reconnecting (a Sentinel or Cluster failover takes a few seconds), rather
 * than being told at once that there is nothing to resume.
 */
export const resumeWait = { ms: 5_000, intervalMs: 100 };

export async function storeAfterReconnect(signal?: AbortSignal): Promise<ChatStreamStore | null> {
  const deadline = Date.now() + resumeWait.ms;
  // Only a client that exists and is reconnecting is worth waiting for.
  while (redisClient && redisClient.status !== 'end' && !signal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, resumeWait.intervalMs));
    const store = await runtimeChatStreamStore();
    if (store) return store;
  }
  return null;
}

/** Whether Redis is configured at all (one server, Sentinel or Cluster). */
export function redisConfigured(): boolean {
  return redisMode(loadEnv()) !== null;
}

/**
 * For other users of the shared client (rate limits, concurrency caps): a
 * command that timed out on a connection that still looks open means the
 * server stopped answering, so reconnect (to the new primary after a
 * failover) instead of letting every later command wait for its timeout.
 */
export function noteRedisFailure(error: unknown): void {
  if (!isRedisUnavailableError(error)) return;
  if (redisReady(redisClient) && /timed out/i.test((error as Error).message))
    redisClient.disconnect(true);
  noteReadiness(false, (error as Error).message);
}

export async function withStore<T>(
  operation: (store: ChatStreamStore) => Promise<T>,
): Promise<T | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    return await operation(store);
  } catch (error) {
    if (isRedisReplyError(error) && !isRedisUnavailableError(error)) {
      // Redis answered: this operation was refused (an expired or finished
      // run), which says nothing about Redis itself.
      logger.warn({ err: error.message }, 'Resumable chat stream operation refused');
      return null;
    }
    if (isRedisUnavailableError(error) && redisClient?.status !== 'end') {
      // The client reconnects by itself. A command that timed out on a
      // connection that still looks open (a primary that stopped answering)
      // means it is not: reconnect, to the new primary after a failover.
      if (redisReady(redisClient) && /timed out/i.test((error as Error).message))
        redisClient.disconnect(true);
      noteReadiness(false, (error as Error).message);
      return null;
    }
    discardClient(error);
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Resumable chat stream persistence failed',
    );
    return null;
  }
}

/**
 * Reports whether resumable streams are actually working, reusing the shared
 * connection rather than opening a second one. `disabled` means no REDIS_URL is
 * configured; `error` means one is configured but unreachable, which is worth
 * surfacing because streams silently fall back to non-resumable.
 */
export async function chatStreamRedisStatus(): Promise<'ok' | 'error' | 'disabled'> {
  if (!redisConfigured()) return 'disabled';
  return (await runtimeChatStreamStore()) ? 'ok' : 'error';
}

/** Closes the shared Redis connection for good (shutdown). */
export async function closeChatStreams(): Promise<void> {
  const client = redisClient;
  runtimeStore = null;
  redisClient = null;
  redisUnavailableUntil = Number.POSITIVE_INFINITY;
  if (client) await client.quit().catch(() => client.disconnect());
}
