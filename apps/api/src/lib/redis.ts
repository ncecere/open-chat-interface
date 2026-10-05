import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import Redis, { Cluster, type ClusterOptions, type RedisOptions, ReplyError } from 'ioredis';
import type { Env } from '../config/env.js';

/**
 * How OCI reaches Redis (v0.11 design, item 16; docs/OPERATIONS.md, "Redis").
 *
 * One server (`REDIS_URL`), Sentinel (`REDIS_SENTINELS` + `REDIS_SENTINEL_NAME`)
 * or Redis Cluster (`REDIS_CLUSTER_NODES`). Every Redis client in the API is
 * built here, so each gets the same failure behaviour:
 *
 * - **Bounded.** A command that cannot be sent (no connection) fails at once
 *   instead of queueing (`enableOfflineQueue: false`); one that was sent
 *   fails after `REDIS_COMMAND_TIMEOUT_MS`. Nothing in a request waits on
 *   Redis for longer than that.
 * - **Never repeated.** A command in flight when the connection drops is not
 *   sent again after the reconnect (`autoResendUnfulfilledCommands: false`):
 *   it may have run, and OCI's appends are not idempotent on their own.
 * - **Reconnecting.** The client keeps trying in the background, with Sentinel
 *   asking the sentinels for the current primary each time and listening for
 *   their `+switch-master` announcements, so a failover is followed within a
 *   second or two of the sentinels deciding it.
 *
 * Callers check `redisReady()` (or use `sharedRedis()`, which returns null
 * while Redis is away) and fall back: what each one does without Redis is in
 * docs/OPERATIONS.md.
 */
export type RedisClient = Redis | Cluster;

export type RedisMode = 'standalone' | 'sentinel' | 'cluster';

type RedisEnv = Pick<
  Env,
  | 'REDIS_URL'
  | 'REDIS_SENTINELS'
  | 'REDIS_SENTINEL_NAME'
  | 'REDIS_SENTINEL_USERNAME'
  | 'REDIS_SENTINEL_PASSWORD'
  | 'REDIS_SENTINEL_TLS'
  | 'REDIS_CLUSTER_NODES'
  | 'REDIS_USERNAME'
  | 'REDIS_PASSWORD'
  | 'REDIS_TLS'
  | 'REDIS_TLS_CA_FILE'
  | 'REDIS_COMMAND_TIMEOUT_MS'
>;

/** How long to wait for a TCP connection to a Redis node or sentinel. */
const CONNECT_TIMEOUT_MS = 1_000;

/** Which kind of Redis is configured, or null for none. Cluster wins over Sentinel over a URL. */
export function redisMode(env: Partial<RedisEnv>): RedisMode | null {
  if (env.REDIS_CLUSTER_NODES?.trim()) return 'cluster';
  if (env.REDIS_SENTINELS?.trim()) return 'sentinel';
  if (env.REDIS_URL?.trim()) return 'standalone';
  return null;
}

/** `host:port,host:port` into addresses; a missing port is `defaultPort`. */
export function parseHostList(value: string, defaultPort: number) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // [IPv6]:port, host:port or host.
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2] ?? defaultPort) };
      const index = entry.lastIndexOf(':');
      if (index > 0 && /^\d+$/.test(entry.slice(index + 1)) && !entry.slice(0, index).includes(':'))
        return { host: entry.slice(0, index), port: Number(entry.slice(index + 1)) };
      return { host: entry, port: defaultPort };
    });
}

function tlsOptions(env: Partial<RedisEnv>): ConnectionOptions {
  return env.REDIS_TLS_CA_FILE ? { ca: readFileSync(env.REDIS_TLS_CA_FILE) } : {};
}

/** Reconnects quickly at first, then every two seconds, for as long as it takes. */
export function reconnectDelay(attempt: number): number {
  return Math.min(100 * 2 ** Math.max(0, attempt - 1), 2_000);
}

/**
 * A replica demoted by a failover answers writes with READONLY until the
 * client notices: reconnect (to the new primary) instead of failing every
 * write until then. The command itself was refused, so it fails as usual.
 */
function reconnectOnError(error: Error): boolean {
  return error.message.startsWith('READONLY');
}

function commonOptions(env: Partial<RedisEnv>, extra: { lazyConnect: boolean }): RedisOptions {
  return {
    lazyConnect: extra.lazyConnect,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS ?? 2_000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    retryStrategy: reconnectDelay,
    reconnectOnError,
  };
}

/**
 * The ioredis options for the configured mode, without connecting. Exported
 * for tests; `createRedisClient` is what code uses.
 */
export function redisClientOptions(env: Partial<RedisEnv>, extra = { lazyConnect: true }) {
  const mode = redisMode(env);
  const common = commonOptions(env, extra);
  if (mode === 'cluster') {
    const redisOptions: ClusterOptions['redisOptions'] = {
      connectTimeout: common.connectTimeout,
      commandTimeout: common.commandTimeout,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: common.maxRetriesPerRequest,
      reconnectOnError,
      ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      ...(env.REDIS_TLS ? { tls: tlsOptions(env) } : {}),
    };
    const cluster: ClusterOptions = {
      lazyConnect: extra.lazyConnect,
      enableOfflineQueue: false,
      // Primaries only: a reply's events are read back as they are written.
      scaleReads: 'master',
      clusterRetryStrategy: reconnectDelay,
      // A failover moves slots: ask again soon rather than failing for long.
      retryDelayOnFailover: 200,
      retryDelayOnClusterDown: 200,
      retryDelayOnTryAgain: 200,
      maxRedirections: 8,
      slotsRefreshTimeout: CONNECT_TIMEOUT_MS * 2,
      redisOptions,
    };
    return {
      mode,
      nodes: parseHostList(env.REDIS_CLUSTER_NODES ?? '', 6379),
      options: cluster,
    } as const;
  }
  if (mode === 'sentinel') {
    const sentinel: RedisOptions = {
      ...common,
      sentinels: parseHostList(env.REDIS_SENTINELS ?? '', 26379),
      name: env.REDIS_SENTINEL_NAME ?? 'mymaster',
      role: 'master',
      // Follow +switch-master at once instead of on the next failed command.
      failoverDetector: true,
      sentinelCommandTimeout: CONNECT_TIMEOUT_MS,
      // Keep asking the sentinels; the client is unavailable meanwhile.
      sentinelRetryStrategy: reconnectDelay,
      ...(env.REDIS_SENTINEL_USERNAME ? { sentinelUsername: env.REDIS_SENTINEL_USERNAME } : {}),
      ...(env.REDIS_SENTINEL_PASSWORD ? { sentinelPassword: env.REDIS_SENTINEL_PASSWORD } : {}),
      ...(env.REDIS_SENTINEL_TLS
        ? { enableTLSForSentinelMode: true, sentinelTLS: tlsOptions(env) }
        : {}),
      ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      ...(env.REDIS_TLS ? { tls: tlsOptions(env) } : {}),
    };
    return { mode, options: sentinel } as const;
  }
  if (mode === 'standalone') {
    const url = env.REDIS_URL!.trim();
    const standalone: RedisOptions = {
      ...common,
      ...(url.startsWith('rediss:') && env.REDIS_TLS_CA_FILE ? { tls: tlsOptions(env) } : {}),
    };
    return { mode, url, options: standalone } as const;
  }
  return null;
}

/**
 * A new client for the configured Redis, or null when none is configured.
 * Lazy: it connects on `connect()` (or the first command, which fails while
 * it is not connected). Errors are emitted as events; the caller must listen.
 */
export function createRedisClient(
  env: Partial<RedisEnv>,
  extra = { lazyConnect: true },
): RedisClient | null {
  const config = redisClientOptions(env, extra);
  if (!config) return null;
  if (config.mode === 'cluster') return new Cluster(config.nodes, config.options);
  if (config.mode === 'sentinel') return new Redis(config.options);
  return new Redis(config.url, config.options);
}

/** Whether the client is connected and accepting commands. */
export function redisReady(client: RedisClient | null | undefined): client is RedisClient {
  return client?.status === 'ready';
}

/**
 * A Redis key part that every key of one entity shares, so Redis Cluster
 * keeps them in one hash slot (`{...}`, a hash tag): MULTI and Lua scripts
 * may only touch keys of one slot there. Only in Cluster mode, so the key
 * names of one server or Sentinel stay as they were (a rolling upgrade from
 * a release before v0.11 keeps reading the same keys).
 */
export function hashTag(value: string, mode: RedisMode | null): string {
  return mode === 'cluster' ? `{${value}}` : value;
}

/**
 * Errors that mean "Redis is away" rather than "this command was wrong": the
 * connection is down, closed while the command was in flight, timed out, or
 * the node is not (any more) the primary for the key.
 */
export function isRedisUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)
  )
    return true;
  return /^(Connection is closed|Stream isn't writeable|Command timed out|Reached the max retries|READONLY|CLUSTERDOWN|TRYAGAIN|LOADING|MASTERDOWN|Failed to refresh slots cache|None of the sentinels are available|All sentinels are unreachable)/.test(
    error.message,
  );
}

/** An error Redis itself answered with (a refused command or a script's error reply). */
export function isRedisReplyError(error: unknown): error is Error {
  return error instanceof ReplyError;
}
