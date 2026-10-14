// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone tool, never a Turbo task.
// The only place node code runs kubectl: every call goes through scopeKubectl (so `-n dev-oci`, no
// other namespace, only the environment's own objects), against the kubeconfig cluster.sh chose.
// Readers return parsed values, or null when a reading could not be taken; a decision that gets
// null treats it as a failure (cluster-guard.mjs).

import { spawnSync } from 'node:child_process';
import { scopeKubectl } from './cluster-guard.mjs';
import {
  etcdSignal,
  parseDf,
  parseKubeletSummary,
  parseNodeList,
  parsePoolAllocation,
} from './cluster-sample.mjs';

const MIB = 1024 * 1024;

export function kubectl(args, { env, input, timeoutMs = 60_000 } = {}) {
  const kubeconfig = process.env.SCALE_KUBECONFIG;
  if (!kubeconfig) throw new Error('SCALE_KUBECONFIG is not set (tools/scale/cluster.sh sets it)');
  const scoped = scopeKubectl(args, { env });
  const result = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, '--request-timeout=30s', ...scoped],
    {
      encoding: 'utf8',
      input,
      timeout: timeoutMs,
      maxBuffer: 256 * MIB,
    },
  );
  return {
    status: result.error ? -1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export const readContext = () => {
  const { status, stdout } = kubectl(['config', 'current-context']);
  return status === 0 ? stdout.trim() : null;
};

export const readNodes = () =>
  attempt(() => {
    const { status, stdout } = kubectl(['get', 'nodes', '-o', 'json']);
    return status === 0 ? parseNodeList(JSON.parse(stdout)) : null;
  });

/** The kubelet's summary through the apiserver's node proxy (cluster-scoped, read-only). */
export const readSummary = (node) =>
  attempt(() => {
    const { status, stdout } = kubectl([
      'get',
      '--raw',
      `/api/v1/nodes/${node}/proxy/stats/summary`,
    ]);
    return status === 0 ? parseKubeletSummary(JSON.parse(stdout)) : null;
  });

/** true / false / null (could not be read) for /readyz/etcd. */
export const readEtcdReady = () => {
  const { status, stdout, stderr } = kubectl(['get', '--raw', '/readyz/etcd']);
  if (status === 0) return stdout.trim() === 'ok';
  return /Internal Server Error|failed|unhealthy/i.test(stderr) ? false : null;
};

/**
 * Metrics text for the latency signal: the output of a command the operator supplied (for etcd's
 * own endpoint), else the apiserver's /metrics, which carries etcd_request_duration_seconds.
 */
export const readMetricsText = (command) => {
  if (command) {
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 256 * MIB,
    });
    return result.status === 0 ? result.stdout : null;
  }
  const { status, stdout } = kubectl(['get', '--raw', '/metrics']);
  return status === 0 ? stdout : null;
};

/** Used bytes of the database volume, from `df` inside the Postgres pod. */
export const readVolume = (env) =>
  attempt(() => {
    const { status, stdout } = kubectl(
      ['exec', `${env}-pg-1`, '-c', 'postgres', '--', 'df', '-Pk', '/var/lib/postgresql/data'],
      { env },
    );
    return status === 0 ? parseDf(stdout) : null;
  });

/**
 * Bytes of the local-dev class allocated on a node, summed from the volumes' capacity and node
 * affinity only (the jsonpath leaves out names, claims and namespaces).
 */
export const readPoolAllocated = (node) =>
  attempt(() => {
    const path =
      '{range .items[*]}{.spec.storageClassName}{"\\t"}{.spec.capacity.storage}{"\\t"}{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}{"\\n"}{end}';
    const { status, stdout } = kubectl(['get', 'pv', '-o', `jsonpath=${path}`]);
    if (status !== 0) return null;
    const perNode = parsePoolAllocation(stdout, 'local-dev');
    return perNode === null ? null : (perNode[node] ?? 0);
  });

export { etcdSignal };
