import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cluster, ReplyError } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  createRedisClient,
  hashTag,
  isRedisReplyError,
  isRedisUnavailableError,
  parseHostList,
  reconnectDelay,
  redisClientOptions,
  redisMode,
  redisReady,
} from '../../lib/redis.js';

/** The Redis client factory (v0.11 design, item 16): one server, Sentinel or Cluster. */
describe('Redis configuration', () => {
  it('picks Cluster over Sentinel over a URL, or none', () => {
    expect(redisMode({})).toBeNull();
    expect(redisMode({ REDIS_URL: ' ' })).toBeNull();
    expect(redisMode({ REDIS_URL: 'redis://r:6379' })).toBe('standalone');
    expect(redisMode({ REDIS_URL: 'redis://r', REDIS_SENTINELS: 's1:26379' })).toBe('sentinel');
    expect(
      redisMode({ REDIS_URL: 'redis://r', REDIS_SENTINELS: 's1', REDIS_CLUSTER_NODES: 'c1' }),
    ).toBe('cluster');
  });

  it('parses host lists with default ports, IPv6 included', () => {
    expect(parseHostList(' a:1, b ,[::1]:7000,[fe80::1], ,c.example:26380', 26379)).toEqual([
      { host: 'a', port: 1 },
      { host: 'b', port: 26379 },
      { host: '::1', port: 7000 },
      { host: 'fe80::1', port: 26379 },
      { host: 'c.example', port: 26380 },
    ]);
  });

  it('bounds every command and never resends one after a reconnect', () => {
    const config = redisClientOptions({ REDIS_URL: 'redis://r:6379/2' });
    expect(config).toMatchObject({
      mode: 'standalone',
      url: 'redis://r:6379/2',
      options: {
        lazyConnect: true,
        connectTimeout: 1_000,
        commandTimeout: 2_000,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
      },
    });
    expect(
      redisClientOptions({ REDIS_URL: 'redis://r', REDIS_COMMAND_TIMEOUT_MS: 500 })?.options,
    ).toMatchObject({ commandTimeout: 500 });
    // READONLY from a demoted primary: reconnect, to the new one.
    const options = config!.options as { reconnectOnError: (error: Error) => boolean };
    expect(options.reconnectOnError(new Error('READONLY You cannot write'))).toBe(true);
    expect(options.reconnectOnError(new Error('WRONGTYPE'))).toBe(false);
  });

  it('configures Sentinel: sentinels, master name, auth and TLS on both sides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oci-redis-ca-'));
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, 'test-ca');
    const config = redisClientOptions({
      REDIS_SENTINELS: 's1:26379,s2,s3:26400',
      REDIS_SENTINEL_NAME: 'oci',
      REDIS_SENTINEL_USERNAME: 'watcher',
      REDIS_SENTINEL_PASSWORD: 'sentinel-secret',
      REDIS_SENTINEL_TLS: true,
      REDIS_USERNAME: 'app',
      REDIS_PASSWORD: 'data-secret',
      REDIS_TLS: true,
      REDIS_TLS_CA_FILE: ca,
    });
    expect(config?.mode).toBe('sentinel');
    expect(config?.options).toMatchObject({
      sentinels: [
        { host: 's1', port: 26379 },
        { host: 's2', port: 26379 },
        { host: 's3', port: 26400 },
      ],
      name: 'oci',
      role: 'master',
      failoverDetector: true,
      sentinelUsername: 'watcher',
      sentinelPassword: 'sentinel-secret',
      enableTLSForSentinelMode: true,
      username: 'app',
      password: 'data-secret',
      enableOfflineQueue: false,
    });
    const tls = config!.options as { tls: { ca: Buffer }; sentinelTLS: { ca: Buffer } };
    expect(tls.tls.ca.toString()).toBe('test-ca');
    expect(tls.sentinelTLS.ca.toString()).toBe('test-ca');
    // Defaults: master "mymaster", no auth, no TLS.
    expect(redisClientOptions({ REDIS_SENTINELS: 's1' })?.options).toMatchObject({
      name: 'mymaster',
    });
    expect(redisClientOptions({ REDIS_SENTINELS: 's1' })?.options).not.toHaveProperty('tls');
  });

  it('configures Cluster: seed nodes, primaries only, bounded node options', () => {
    const config = redisClientOptions({
      REDIS_CLUSTER_NODES: 'c1:7000,c2:7001',
      REDIS_PASSWORD: 'secret',
      REDIS_TLS: true,
    });
    expect(config).toMatchObject({
      mode: 'cluster',
      nodes: [
        { host: 'c1', port: 7000 },
        { host: 'c2', port: 7001 },
      ],
      options: {
        enableOfflineQueue: false,
        scaleReads: 'master',
        redisOptions: {
          commandTimeout: 2_000,
          autoResendUnfulfilledCommands: false,
          password: 'secret',
          tls: {},
        },
      },
    });
    expect(redisClientOptions({})).toBeNull();
  });

  it('uses TLS options for rediss:// only when a CA file is given', () => {
    expect(redisClientOptions({ REDIS_URL: 'rediss://r' })?.options).not.toHaveProperty('tls');
  });

  it('creates the right client, lazily', () => {
    expect(createRedisClient({})).toBeNull();
    const standalone = createRedisClient({ REDIS_URL: 'redis://127.0.0.1:1' })!;
    const sentinel = createRedisClient({ REDIS_SENTINELS: '127.0.0.1:1' })!;
    const cluster = createRedisClient({ REDIS_CLUSTER_NODES: '127.0.0.1:1' })!;
    try {
      expect(standalone.isCluster).toBe(false);
      expect(sentinel.isCluster).toBe(false);
      expect(cluster).toBeInstanceOf(Cluster);
      for (const client of [standalone, sentinel, cluster]) {
        expect(client.status).toBe('wait');
        expect(redisReady(client)).toBe(false);
      }
      expect(redisReady(null)).toBe(false);
    } finally {
      for (const client of [standalone, sentinel, cluster]) client.disconnect();
    }
  });

  it('reconnects quickly at first, then every two seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(reconnectDelay)).toEqual([
      100, 200, 400, 800, 1_600, 2_000, 2_000,
    ]);
  });

  it('tags keys for Cluster only', () => {
    expect(hashTag('run-1', 'cluster')).toBe('{run-1}');
    expect(hashTag('run-1', 'sentinel')).toBe('run-1');
    expect(hashTag('run-1', null)).toBe('run-1');
  });

  it('tells "Redis is away" from "the command was refused"', () => {
    for (const message of [
      'Connection is closed.',
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Command timed out',
      'READONLY You cannot write against a read only replica.',
      'CLUSTERDOWN The cluster is down',
      'MASTERDOWN Link with MASTER is down',
      'LOADING Redis is loading the dataset in memory',
    ])
      expect(isRedisUnavailableError(new Error(message)), message).toBe(true);
    expect(
      isRedisUnavailableError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
    ).toBe(true);
    expect(isRedisUnavailableError(new Error('Chat stream metadata expired'))).toBe(false);
    expect(isRedisUnavailableError('Connection is closed')).toBe(false);
    expect(isRedisReplyError(new ReplyError('ERR wrong'))).toBe(true);
    expect(isRedisReplyError(new Error('ERR wrong'))).toBe(false);
  });
});
