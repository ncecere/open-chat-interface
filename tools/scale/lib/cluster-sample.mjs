// Parsers for the readings the cluster watcher and preflight take (cluster-watch.mjs,
// cluster-preflight.mjs). Pure: text or JSON in, numbers out; a reading that cannot be parsed is
// null (or throws for a payload that is not the expected document), never a guess.

import { parseQuantity } from './cluster-guard.mjs';

const toNumber = (text) => (text === '+Inf' ? Number.POSITIVE_INFINITY : Number(text));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cumulative histogram buckets of `name`, summed over every series, as a Map of upper bound to
 * count in ascending order (+Inf last), or null if the text has none.
 */
export function parseHistogram(text, name) {
  const line = new RegExp(`^${escapeRegExp(name)}_bucket\\{([^}]*)\\}\\s+([-+eE0-9.]+|NaN)\\s*$`);
  const sums = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const match = line.exec(raw);
    if (!match) continue;
    const le = /(?:^|,)le="([^"]+)"/.exec(match[1]);
    if (!le) continue;
    const bound = toNumber(le[1]);
    sums.set(bound, (sums.get(bound) ?? 0) + Number(match[2]));
  }
  return sums.size === 0 ? null : new Map([...sums.entries()].sort((a, b) => a[0] - b[0]));
}

/** The sum of a counter over its series, or null if it is absent. */
export function parseCounter(text, name) {
  const line = new RegExp(`^${escapeRegExp(name)}(?:\\{[^}]*\\})?\\s+([-+eE0-9.]+)\\s*$`);
  let total = null;
  for (const raw of String(text ?? '').split('\n')) {
    const match = line.exec(raw);
    if (match) total = (total ?? 0) + Number(match[1]);
  }
  return total;
}

/**
 * The q-quantile, in the histogram's unit, of the observations made between two scrapes
 * (Prometheus' histogram_quantile over the difference), or null when there were none or either
 * scrape is missing. A counter that went backwards (a restart) is read from the new counts alone.
 */
export function histogramQuantile(before, after, q) {
  if (!before || !after) return null;
  const bounds = [...after.keys()];
  const reset = bounds.some((le) => (after.get(le) ?? 0) < (before.get(le) ?? 0));
  const delta = bounds.map((le) => [
    le,
    reset ? after.get(le) : after.get(le) - (before.get(le) ?? 0),
  ]);
  const total = delta[delta.length - 1]?.[1] ?? 0;
  if (!(total > 0)) return null;
  const rank = q * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const [le, count] of delta) {
    if (count >= rank) {
      if (le === Number.POSITIVE_INFINITY) return lowerBound;
      return lowerBound + (le - lowerBound) * ((rank - lowerCount) / (count - lowerCount || 1));
    }
    lowerBound = le;
    lowerCount = count;
  }
  return lowerBound;
}

const WAL = 'etcd_disk_wal_fsync_duration_seconds';
const APISERVER = 'etcd_request_duration_seconds';
const toMs = (seconds) => (seconds === null ? null : Math.round(seconds * 1e6) / 1000);

/**
 * The latency signal from two scrapes of a metrics endpoint: etcd's own WAL fsync histogram if the
 * text has it (and the leader change counter), else the apiserver's request latency to etcd, a
 * coarser proxy that cluster-guard.mjs gives looser thresholds. `source` is null with neither.
 */
export function etcdSignal(beforeText, afterText) {
  const source = parseHistogram(afterText, WAL)
    ? 'wal-fsync'
    : parseHistogram(afterText, APISERVER)
      ? 'apiserver-request'
      : null;
  if (source === null) return { source, p99Ms: null, leaderChanges: null };
  const name = source === 'wal-fsync' ? WAL : APISERVER;
  const seconds = histogramQuantile(
    parseHistogram(beforeText, name),
    parseHistogram(afterText, name),
    0.99,
  );
  return {
    source,
    p99Ms: toMs(seconds),
    leaderChanges:
      source === 'wal-fsync'
        ? parseCounter(afterText, 'etcd_server_leader_changes_seen_total')
        : null,
  };
}

function cpuCores(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d+)(m?)$/.exec(text);
  return match ? Number(match[1]) / (match[2] ? 1000 : 1) : null;
}

function memoryBytes(text) {
  try {
    return parseQuantity(text);
  } catch {
    return null;
  }
}

/** `kubectl get nodes -o json`: readiness, pressure conditions, capacity and what runs there. */
export function parseNodeList(json) {
  return (json?.items ?? []).map((item) => {
    const conditions = Object.fromEntries(
      (item.status?.conditions ?? []).map((c) => [c.type, c.status]),
    );
    const known = ['MemoryPressure', 'DiskPressure', 'PIDPressure'].every(
      (type) => type in conditions,
    );
    const info = item.status?.nodeInfo ?? {};
    return {
      name: item.metadata.name,
      ready: conditions.Ready === 'True',
      pressure: known
        ? {
            memory: conditions.MemoryPressure === 'True',
            disk: conditions.DiskPressure === 'True',
            pid: conditions.PIDPressure === 'True',
          }
        : null,
      cpuCores: cpuCores(item.status?.capacity?.cpu),
      memoryBytes: memoryBytes(item.status?.capacity?.memory),
      kernel: info.kernelVersion ?? null,
      os: info.osImage ?? null,
      arch: info.architecture ?? null,
      kubelet: info.kubeletVersion ?? null,
    };
  });
}

/** The kubelet's /stats/summary (through the apiserver's node proxy): the node's CPU and disk. */
export function parseKubeletSummary(json) {
  if (!json || typeof json !== 'object' || !json.node)
    throw new Error('Not a kubelet summary (no "node")');
  const { cpu, memory, fs } = json.node;
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    cpuNanoCores: number(cpu?.usageNanoCores),
    memoryAvailableBytes: number(memory?.availableBytes),
    fsAvailableBytes: number(fs?.availableBytes),
    fsCapacityBytes: number(fs?.capacityBytes),
    fsUsedBytes: number(fs?.usedBytes),
  };
}

/** Mean busy share of a node over CPU samples (nanocores), or null if any sample is missing. */
export function cpuBusyFraction(nanoCoreSamples, cores) {
  if (!nanoCoreSamples.length || !(cores > 0) || nanoCoreSamples.some((s) => typeof s !== 'number'))
    return null;
  const mean = nanoCoreSamples.reduce((a, b) => a + b, 0) / nanoCoreSamples.length;
  return mean / (cores * 1e9);
}

/** `df -Pk <path>` of the database volume. */
export function parseDf(text) {
  const row = String(text ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((f) => f.length >= 6 && [1, 2, 3].every((i) => /^\d+$/.test(f[i])));
  if (!row) return null;
  return {
    capacityBytes: Number(row[1]) * 1024,
    usedBytes: Number(row[2]) * 1024,
    availableBytes: Number(row[3]) * 1024,
  };
}

/**
 * Bytes of the storage class allocated per node, from tab-separated `class capacity node` lines
 * (`kubectl get pv -o jsonpath` limited to those three fields, so nothing else about other
 * namespaces' volumes is read). null if any volume of the class cannot be read.
 */
export function parsePoolAllocation(tsv, storageClass) {
  const perNode = {};
  for (const line of String(tsv ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [klass, capacity, node] = line.split('\t');
    if (klass !== storageClass) continue;
    let bytes;
    try {
      bytes = parseQuantity(capacity);
    } catch {
      return null;
    }
    if (!node) return null;
    perNode[node] = (perNode[node] ?? 0) + bytes;
  }
  return perNode;
}

/** `dev-env list oci`: the environment names, or null if the output is not that table. */
export function parseDevEnvList(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0 || !lines[0].startsWith('PROJECT')) return null;
  return lines
    .slice(1)
    .map((l) => l.split(/\s+/))
    .filter((f) => f[0] === 'oci')
    .map((f) => f[1]);
}
