import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import Redis from 'ioredis';

const run = promisify(execFile);

/**
 * Highly available Redis for live tests (v0.11 design, item 16), in one
 * Docker container so it starts in seconds and needs no compose project:
 *
 * - **Sentinel**: a primary, one replica and three sentinels (quorum 2,
 *   `down-after-milliseconds 1000`), every process announcing 127.0.0.1 and
 *   its own port, which is published under the same number;
 * - **Cluster**: three primaries (no replicas), slots spread by
 *   `redis-cli --cluster create`.
 *
 * Redis 7.2 (BSD-3-Clause, the last release before the licence change),
 * pinned by digest, as in tools/failover-drill.
 */
export const REDIS_IMAGE =
  'redis:7.2.10-alpine@sha256:395ccd7ee4db0867de0d0410f4712a9e0331cff9fdbd864f71ec0f7982d3ffe6';

/**
 * Free ports between 20000 and 50000: low enough that a cluster's bus port
 * (port + 10000) is valid too, and outside the usual ephemeral ranges.
 */
async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    const candidate = 20_000 + Math.floor(Math.random() * 30_000);
    if (ports.has(candidate)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) ports.add(candidate);
  }
  return [...ports];
}

async function startContainer(name: string, ports: number[], script: string) {
  const linux = process.platform === 'linux';
  const network = linux
    ? ['--network', 'host']
    : ports.flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]);
  await run(
    'docker',
    ['run', '-d', '--rm', '--name', name, ...network, REDIS_IMAGE, 'sh', '-c', script],
    { timeout: 120_000 },
  );
}

async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function ask(port: number, ...command: [string, ...(string | number)[]]): Promise<unknown> {
  const client = new Redis({
    host: '127.0.0.1',
    port,
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return await client.call(...command);
  } finally {
    client.disconnect();
  }
}

export interface RedisSentinelSet {
  masterName: string;
  sentinels: string;
  primaryPort: number;
  /** The port of whichever node the sentinels currently call the primary. */
  currentPrimaryPort(): Promise<number>;
  /** SIGKILL for the current primary's process; returns its port. */
  killPrimary(): Promise<number>;
  stop(): Promise<void>;
}

export async function startRedisSentinel(): Promise<RedisSentinelSet> {
  const [primary, replica, ...sentinels] = await freePorts(5);
  const masterName = 'oci';
  const name = `oci-test-sentinel-${randomUUID().slice(0, 8)}`;
  const node = (port: number, extra = '') =>
    `redis-server --port ${port} --save '' --appendonly no --daemonize yes --replica-announce-ip 127.0.0.1 ${extra}`;
  const sentinel = (port: number) =>
    [
      `printf '%s\\n'`,
      `'port ${port}'`,
      `'sentinel announce-ip 127.0.0.1'`,
      `'sentinel monitor ${masterName} 127.0.0.1 ${primary} 2'`,
      `'sentinel down-after-milliseconds ${masterName} 1000'`,
      `'sentinel failover-timeout ${masterName} 5000'`,
      `'sentinel parallel-syncs ${masterName} 1'`,
      `> /tmp/sentinel-${port}.conf && redis-sentinel /tmp/sentinel-${port}.conf --daemonize yes`,
    ].join(' ');
  const script = [
    node(primary!),
    node(replica!, `--replicaof 127.0.0.1 ${primary}`),
    ...sentinels.map(sentinel),
    'exec tail -f /dev/null',
  ].join(' && ');
  await startContainer(name, [primary!, replica!, ...sentinels], script);

  const set: RedisSentinelSet = {
    masterName,
    sentinels: sentinels.map((port) => `127.0.0.1:${port}`).join(','),
    primaryPort: primary!,
    async currentPrimaryPort() {
      const reply = (await ask(
        sentinels[0]!,
        'SENTINEL',
        'get-master-addr-by-name',
        masterName,
      )) as [string, string];
      return Number(reply[1]);
    },
    async killPrimary() {
      const port = await set.currentPrimaryPort();
      await run('docker', [
        'exec',
        name,
        'sh',
        '-c',
        `kill -9 $(ps -o pid,args | grep 'redis-server \\*:${port}' | grep -v grep | awk '{print $1}')`,
      ]);
      return port;
    },
    async stop() {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    },
  };
  try {
    // Ready: the replica is in sync and every sentinel knows both nodes.
    await waitUntil('the replica to sync', async () =>
      String(await ask(replica!, 'INFO', 'replication')).includes('master_link_status:up'),
    );
    for (const port of sentinels)
      await waitUntil('the sentinels to see the replica', async () => {
        const replicas = (await ask(port, 'SENTINEL', 'replicas', masterName)) as unknown[];
        const sentinelsSeen = (await ask(port, 'SENTINEL', 'sentinels', masterName)) as unknown[];
        return replicas.length === 1 && sentinelsSeen.length === 2;
      });
  } catch (error) {
    await set.stop();
    throw error;
  }
  return set;
}

export interface RedisClusterSet {
  nodes: string;
  stop(): Promise<void>;
}

export async function startRedisCluster(): Promise<RedisClusterSet> {
  const ports = await freePorts(3);
  const name = `oci-test-cluster-${randomUUID().slice(0, 8)}`;
  // Cluster bus ports are the data port + 10000; inside the container only.
  const script = `${[
    ...ports.map(
      (port) =>
        `redis-server --port ${port} --cluster-enabled yes --cluster-config-file /tmp/nodes-${port}.conf --cluster-node-timeout 2000 --cluster-announce-ip 127.0.0.1 --save '' --appendonly no --daemonize yes`,
    ),
    // Wait until every node answers before creating the cluster, and retry
    // the create: on a busy runner a node not yet listening made it fail, and
    // with `&&` the container then exited and the cluster never formed.
    ...ports.map((port) => `until redis-cli -p ${port} ping >/dev/null 2>&1; do sleep 0.2; done`),
    `for attempt in 1 2 3 4 5; do redis-cli --cluster create ${ports.map((port) => `127.0.0.1:${port}`).join(' ')} --cluster-replicas 0 --cluster-yes && break; sleep 1; done`,
  ].join(' && ')}; exec tail -f /dev/null`;
  await startContainer(name, ports, script);
  const stop = async () => {
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
  };
  try {
    // Every node agrees, and knows every slot's owner (a busy machine makes
    // the nodes take a few seconds to converge after `--cluster create`).
    await waitUntil(
      'the cluster to form',
      async () => {
        for (const port of ports) {
          const info = String(await ask(port, 'CLUSTER', 'INFO'));
          if (!info.includes('cluster_state:ok') || !info.includes('cluster_slots_ok:16384'))
            return false;
          if (!/cluster_known_nodes:3\b/.test(info)) return false;
        }
        return true;
      },
      60_000,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { nodes: ports.map((port) => `127.0.0.1:${port}`).join(','), stop };
}
