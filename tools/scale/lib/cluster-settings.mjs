// What cluster.sh changes in a `dev-env up oci` environment before the run, as data: the harness's
// PostgreSQL settings, resource requests and limits, the API's harness environment and the node
// pinning of the load side. Tested in scripts/scale-cluster-settings.test.mjs.

/**
 * Starting values from the spec, to be set from node capacity at gate G1 (the node capacity was
 * not read when the spec was written). Kubernetes has no disk-I/O limit; these bound CPU and memory.
 */
export const RESOURCES = {
  postgres: { requests: { cpu: '2', memory: '6Gi' }, limits: { cpu: '4', memory: '8Gi' } },
  api: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
};

/** `kubectl set resources` flags for the API and the worker (the spec gives no separate worker value). */
export function resourceFlags(component) {
  const resources = RESOURCES[component];
  if (!resources) throw new Error(`No resources defined for ${component}`);
  const flag = (kind) =>
    `--${kind}=${Object.entries(resources[kind])
      .map(([name, value]) => `${name}=${value}`)
      .join(',')}`;
  return [flag('requests'), flag('limits')];
}

const MB = 1024 ** 2;

/**
 * The settings of tools/scale/compose.yaml (`shared_buffers` and friends keep their compose
 * defaults), as a merge patch for the CloudNativePG Cluster. pg_stat_statements is preloaded by
 * CloudNativePG when its parameters are set (to verify at G1: the environment step fails the run
 * if the view cannot be read). max_wal_size is the compose value (8GB) but never more than a
 * quarter of the volume: a small claim must not be filled by WAL.
 */
export function pgPatch(pgSizeBytes) {
  const walMb = Math.min(8192, Math.floor(pgSizeBytes / 4 / MB));
  return {
    spec: {
      postgresql: {
        parameters: {
          'pg_stat_statements.track': 'top',
          'pg_stat_statements.max': '10000',
          track_io_timing: 'on',
          max_connections: '400',
          shared_buffers: '1GB',
          effective_cache_size: '3GB',
          work_mem: '16MB',
          maintenance_work_mem: '512MB',
          max_wal_size: walMb >= 8192 ? '8GB' : `${walMb}MB`,
          checkpoint_timeout: '15min',
          wal_compression: 'on',
          random_page_cost: '1.1',
          max_parallel_maintenance_workers: '2',
        },
      },
      resources: structuredClone(RESOURCES.postgres),
    },
  };
}

/**
 * The API's environment as the harness sets it (compose.yaml): rate limits out of the way, since
 * every virtual user signs in far more often than a person, and a metrics token read from a Secret.
 * Retention windows are set after generation (retentionWindows).
 */
export function apiEnvironment(env) {
  return {
    literals: {
      RATE_LIMIT_AUTH_PER_MINUTE: '1000000',
      RATE_LIMIT_CHAT_PER_MINUTE: '100000',
      RATE_LIMIT_MAX_CONCURRENT_STREAMS: '100',
      RATE_LIMIT_UPLOAD_PER_MINUTE: '100000',
      LOG_LEVEL: 'warn',
    },
    fromSecret: { name: `${env}-scale-harness`, keys: ['METRICS_TOKEN'] },
  };
}

/**
 * dev-env sets no web.trustedProxies, so the proxy would ignore the X-Forwarded-For that gives each
 * simulated person an address and every sign-in would share one rate limit (compose.yaml does the same).
 */
export function webEnvironment() {
  return { TRUSTED_PROXIES: 'private_ranges' };
}

/**
 * Windows that prune about the oldest quarter, from the age in days of the oldest usage event and
 * audit entry; the same rule as `suggestedRetentionDays` in tools/scale/generate.mjs.
 */
export function retentionWindows({ usageDays, auditDays }) {
  const quarter = (days, fallback) => Math.max(1, Math.floor(Number(days ?? fallback) * 0.75));
  return { usageEvents: quarter(usageDays, 90), auditLog: quarter(auditDays, 365) };
}

/** Pins a Deployment's pods to a node by hostname (a strategic merge patch). */
export function nodeSelectorPatch(node) {
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(node ?? ''))
    throw new Error(`${JSON.stringify(node)} is not a node name`);
  return { spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': node } } } } };
}
