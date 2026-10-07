// Redis under Sentinel: primary lookup, replica sync, health and the Redis failover.

import { compose, must, waitFor } from './cluster.mjs';
import { log, SENTINELS } from './context.mjs';

/** The host name the sentinels give for the Redis primary (the Compose service name). */
async function sentinelPrimary() {
  for (const sentinel of SENTINELS) {
    const result = await compose([
      'exec',
      '-T',
      sentinel,
      'redis-cli',
      '-p',
      '26379',
      'SENTINEL',
      'get-master-addr-by-name',
      'oci',
    ]);
    const host = result.stdout.trim().split('\n')[0];
    if (result.code === 0 && host) return host;
  }
  return null;
}

/** Whether `service` is a Redis replica in sync with its primary. */
export async function redisReplicaInSync(service) {
  const result = await compose(['exec', '-T', service, 'redis-cli', 'INFO', 'replication']);
  return result.stdout.includes('role:slave') && result.stdout.includes('master_link_status:up');
}

/** The Redis row of System health, as one API replica sees it. */
export async function redisHealth(admin) {
  const health = await admin('GET', '/api/admin/health');
  return health.json?.checks?.find((check) => check.id === 'redis') ?? null;
}

/**
 * Kills the Redis primary (SIGKILL), waits for the sentinels to promote the
 * replica and for the API to use Redis again, then starts the killed node,
 * which the sentinels turn into a replica of the new primary (for the next
 * failover).
 */
export async function redisFailover(index, admin) {
  const primary = await sentinelPrimary();
  if (!primary) throw new Error('The sentinels name no Redis primary');
  log(`Redis failover ${index + 1}: killing the primary ${primary}`);
  const t0 = Date.now();
  await must(compose(['kill', '-s', 'SIGKILL', primary]), 'killing the Redis primary');
  let promotedTo = null;
  const promoted = await waitFor(
    'the sentinels to promote the replica',
    async () => {
      const now = await sentinelPrimary();
      if (!now || now === primary) return null;
      promotedTo = now;
      return Date.now();
    },
    60_000,
    100,
  );
  // Both web replicas: System health is answered by whichever the proxy picks.
  let healthy = 0;
  const followed = await waitFor(
    'the API to use Redis again',
    async () => {
      healthy = (await redisHealth(admin))?.status === 'ok' ? healthy + 1 : 0;
      return healthy >= 4 ? Date.now() : null;
    },
    60_000,
    100,
  );
  await must(compose(['start', primary]), 'starting the old Redis primary again');
  await waitFor(
    'the old primary to rejoin as a replica',
    () => redisReplicaInSync(primary),
    60_000,
    500,
  );
  log(
    `Redis failover ${index + 1}: ${promotedTo} promoted after ${promoted - t0} ms; the API used Redis again after ${followed - t0} ms; ${primary} rejoined as a replica`,
  );
  return {
    from: primary,
    to: promotedTo,
    startedAt: t0,
    commandMs: promoted - t0,
    routedMs: followed - t0,
  };
}
