// The readings the cluster watcher and preflight take (tools/scale/lib/cluster-sample.mjs):
// Prometheus histograms to a p99, the kubelet summary, node conditions, df, the pool's allocation.
// Inputs are synthetic samples shaped like the real formats (no cluster was contacted to write
// them); the first G0 run on the cluster is what shows they match.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuBusyFraction,
  etcdSignal,
  histogramQuantile,
  parseCounter,
  parseDevEnvList,
  parseDf,
  parseHistogram,
  parseKubeletSummary,
  parseNodeList,
  parsePoolAllocation,
} from '../tools/scale/lib/cluster-sample.mjs';

const GIB = 1024 ** 3;

const wal = (cumulative, leaderChanges = 3) =>
  [
    '# HELP etcd_disk_wal_fsync_duration_seconds The latency distributions of fsync called by WAL.',
    '# TYPE etcd_disk_wal_fsync_duration_seconds histogram',
    ...Object.entries(cumulative).map(
      ([le, n]) => `etcd_disk_wal_fsync_duration_seconds_bucket{le="${le}"} ${n}`,
    ),
    `etcd_disk_wal_fsync_duration_seconds_sum 1.5`,
    `etcd_disk_wal_fsync_duration_seconds_count ${cumulative['+Inf']}`,
    '# TYPE etcd_server_leader_changes_seen_total counter',
    `etcd_server_leader_changes_seen_total ${leaderChanges}`,
    '',
  ].join('\n');

test('parseHistogram reads cumulative buckets, summed over series', () => {
  const text = [
    'etcd_request_duration_seconds_bucket{operation="get",type="pods",le="0.005"} 5',
    'etcd_request_duration_seconds_bucket{operation="get",type="pods",le="+Inf"} 8',
    'etcd_request_duration_seconds_bucket{operation="create",type="pods",le="0.005"} 1',
    'etcd_request_duration_seconds_bucket{operation="create",type="pods",le="+Inf"} 2',
    'etcd_request_duration_seconds_count{operation="get",type="pods"} 8',
    'other_total 4',
  ].join('\n');
  const histogram = parseHistogram(text, 'etcd_request_duration_seconds');
  assert.deepEqual(
    [...histogram.entries()],
    [
      [0.005, 6],
      [Number.POSITIVE_INFINITY, 10],
    ],
  );
  assert.equal(parseHistogram(text, 'absent'), null);
});

test('p99 uses only the observations between two scrapes', () => {
  const name = 'etcd_disk_wal_fsync_duration_seconds';
  // 1000 old observations, mostly fast; then 100 new ones: 90 up to 4 ms, 99 up to 8 ms, all up to 16 ms.
  const before = parseHistogram(wal({ 0.004: 900, 0.008: 990, 0.016: 1000, '+Inf': 1000 }), name);
  const after = parseHistogram(wal({ 0.004: 990, 0.008: 1089, 0.016: 1100, '+Inf': 1100 }), name);
  assert.ok(Math.abs(histogramQuantile(before, after, 0.99) - 0.008) < 1e-12);
});

test('p99 lands on a bucket bound when the rank falls on it, and interpolates inside one', () => {
  const none = parseHistogram(
    wal({ 0.004: 0, 0.008: 0, 0.016: 0, '+Inf': 0 }),
    'etcd_disk_wal_fsync_duration_seconds',
  );
  const now = parseHistogram(
    wal({ 0.004: 90, 0.008: 99, 0.016: 100, '+Inf': 100 }),
    'etcd_disk_wal_fsync_duration_seconds',
  );
  assert.ok(Math.abs(histogramQuantile(none, now, 0.99) - 0.008) < 1e-12);
  // Half way through a bucket: rank 50 of 100 with 0 up to 0.004 and 100 up to 0.008.
  const flat = parseHistogram(
    wal({ 0.004: 0, 0.008: 100, '+Inf': 100 }),
    'etcd_disk_wal_fsync_duration_seconds',
  );
  assert.ok(Math.abs(histogramQuantile(none, flat, 0.5) - 0.006) < 1e-12);
});

test('observations beyond the last bound report that bound, and no new observations report null', () => {
  const none = parseHistogram(wal({ 0.1: 0, '+Inf': 0 }), 'etcd_disk_wal_fsync_duration_seconds');
  const slow = parseHistogram(wal({ 0.1: 1, '+Inf': 100 }), 'etcd_disk_wal_fsync_duration_seconds');
  assert.equal(histogramQuantile(none, slow, 0.99), 0.1);
  assert.equal(histogramQuantile(slow, slow, 0.99), null);
  assert.equal(histogramQuantile(null, slow, 0.99), null);
  assert.equal(histogramQuantile(slow, null, 0.99), null);
});

test('a counter reset (etcd restarted) is read from the new counts alone', () => {
  const before = parseHistogram(
    wal({ 0.004: 5000, 0.008: 5000, '+Inf': 5000 }),
    'etcd_disk_wal_fsync_duration_seconds',
  );
  const after = parseHistogram(
    wal({ 0.004: 10, 0.008: 10, '+Inf': 10 }),
    'etcd_disk_wal_fsync_duration_seconds',
  );
  assert.ok(histogramQuantile(before, after, 0.99) <= 0.004);
});

test('parseCounter sums the series, or is null when absent', () => {
  assert.equal(parseCounter('a_total{x="1"} 3\na_total{x="2"} 4\n', 'a_total'), 7);
  assert.equal(parseCounter('b_total 1\n', 'a_total'), null);
});

test("etcdSignal prefers etcd's own WAL fsync histogram and names its source", () => {
  const a = wal({ 0.004: 0, 0.008: 0, '+Inf': 0 }, 3);
  const b = wal({ 0.004: 90, 0.008: 99, '+Inf': 100 }, 4);
  assert.deepEqual(etcdSignal(a, b), { source: 'wal-fsync', p99Ms: 8, leaderChanges: 4 });
  // The first scrape has nothing to compare with.
  assert.deepEqual(etcdSignal(null, b), { source: 'wal-fsync', p99Ms: null, leaderChanges: 4 });
});

test('etcdSignal falls back to the apiserver request latency, without leader changes', () => {
  const series = (n, total) =>
    [
      `etcd_request_duration_seconds_bucket{operation="get",type="pods",le="0.025"} ${n}`,
      `etcd_request_duration_seconds_bucket{operation="get",type="pods",le="0.05"} ${total}`,
      `etcd_request_duration_seconds_bucket{operation="get",type="pods",le="+Inf"} ${total}`,
    ].join('\n');
  const signal = etcdSignal(series(0, 0), series(90, 100));
  assert.equal(signal.source, 'apiserver-request');
  assert.equal(signal.leaderChanges, null);
  assert.ok(signal.p99Ms > 25 && signal.p99Ms <= 50);
  assert.deepEqual(etcdSignal('', ''), { source: null, p99Ms: null, leaderChanges: null });
});

const NODE_LIST = {
  items: [
    {
      metadata: { name: 'talos-cp-3', labels: { 'kubernetes.io/hostname': 'talos-cp-3' } },
      status: {
        capacity: { cpu: '8', memory: '32594612Ki' },
        conditions: [
          { type: 'MemoryPressure', status: 'False' },
          { type: 'DiskPressure', status: 'False' },
          { type: 'PIDPressure', status: 'False' },
          { type: 'Ready', status: 'True' },
        ],
        nodeInfo: {
          kernelVersion: '6.12.43-talos',
          osImage: 'Talos (v1.11.0)',
          architecture: 'amd64',
          kubeletVersion: 'v1.34.0',
        },
      },
    },
    {
      metadata: { name: 'talos-cp-2' },
      status: {
        capacity: { cpu: '4000m', memory: '16Gi' },
        conditions: [
          { type: 'MemoryPressure', status: 'False' },
          { type: 'DiskPressure', status: 'True' },
          { type: 'PIDPressure', status: 'False' },
          { type: 'Ready', status: 'False' },
        ],
        nodeInfo: {},
      },
    },
  ],
};

test('parseNodeList reads readiness, pressure and capacity', () => {
  const [cp3, cp2] = parseNodeList(NODE_LIST);
  assert.deepEqual(cp3, {
    name: 'talos-cp-3',
    ready: true,
    pressure: { memory: false, disk: false, pid: false },
    cpuCores: 8,
    memoryBytes: 32_594_612 * 1024,
    kernel: '6.12.43-talos',
    os: 'Talos (v1.11.0)',
    arch: 'amd64',
    kubelet: 'v1.34.0',
  });
  assert.equal(cp2.ready, false);
  assert.deepEqual(cp2.pressure, { memory: false, disk: true, pid: false });
  assert.equal(cp2.cpuCores, 4);
  assert.equal(cp2.memoryBytes, 16 * GIB);
});

test('a node without the pressure conditions is read as unknown, not as healthy', () => {
  const [node] = parseNodeList({
    items: [
      {
        metadata: { name: 'x' },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          capacity: { cpu: '2', memory: '1Gi' },
        },
      },
    ],
  });
  assert.equal(node.pressure, null);
});

test('parseKubeletSummary reads CPU use and filesystem bytes', () => {
  const summary = {
    node: {
      nodeName: 'talos-cp-3',
      cpu: { usageNanoCores: 1_600_000_000, usageCoreNanoSeconds: 9 },
      memory: { availableBytes: 20 * GIB, workingSetBytes: 5 * GIB },
      fs: { availableBytes: 600 * GIB, capacityBytes: 930 * GIB, usedBytes: 330 * GIB },
    },
    pods: [{ podRef: { name: 'ignored' } }],
  };
  assert.deepEqual(parseKubeletSummary(summary), {
    cpuNanoCores: 1_600_000_000,
    memoryAvailableBytes: 20 * GIB,
    fsAvailableBytes: 600 * GIB,
    fsCapacityBytes: 930 * GIB,
    fsUsedBytes: 330 * GIB,
  });
  assert.deepEqual(parseKubeletSummary({ node: {} }), {
    cpuNanoCores: null,
    memoryAvailableBytes: null,
    fsAvailableBytes: null,
    fsCapacityBytes: null,
    fsUsedBytes: null,
  });
  assert.throws(() => parseKubeletSummary({}), /summary/i);
});

test("cpuBusyFraction averages the samples against the node's cores", () => {
  assert.equal(cpuBusyFraction([1e9, 3e9], 8), 0.25);
  assert.equal(cpuBusyFraction([], 8), null);
  assert.equal(cpuBusyFraction([1e9, null], 8), null);
  assert.equal(cpuBusyFraction([1e9], 0), null);
});

test('parseDf reads `df -Pk` of the data volume', () => {
  const text = [
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/loop3       157286400  41943040 108003328      28% /var/lib/postgresql/data',
    '',
  ].join('\n');
  assert.deepEqual(parseDf(text), {
    capacityBytes: 157_286_400 * 1024,
    usedBytes: 41_943_040 * 1024,
    availableBytes: 108_003_328 * 1024,
  });
  assert.equal(parseDf(''), null);
  assert.equal(parseDf('df: /nope: No such file or directory'), null);
});

test('parsePoolAllocation sums the local-dev volumes per node', () => {
  const tsv = [
    'local-dev\t150Gi\ttalos-cp-3',
    'local-dev\t5Gi\ttalos-cp-3',
    'local-dev\t40Gi\ttalos-cp-1',
    'nfs-dev\t1Ti\t',
    'other\t10Gi\ttalos-cp-3',
    '',
  ].join('\n');
  assert.deepEqual(parsePoolAllocation(tsv, 'local-dev'), {
    'talos-cp-3': 155 * GIB,
    'talos-cp-1': 40 * GIB,
  });
  assert.deepEqual(parsePoolAllocation('', 'local-dev'), {});
  // One volume that cannot be read makes the whole reading unreliable.
  assert.equal(parsePoolAllocation('local-dev\t1.5Gi\ttalos-cp-3\n', 'local-dev'), null);
  assert.equal(parsePoolAllocation('local-dev\t10Gi\t\n', 'local-dev'), null);
});

test('parseDevEnvList returns the environment names under the header', () => {
  const header = 'PROJECT  NAME     REF   IMAGES        EXPIRES IN';
  assert.deepEqual(parseDevEnvList(`${header}\n`), []);
  assert.deepEqual(
    parseDevEnvList(
      `${header}\noci      walk1    main  dev-abc123    7h12m\noci      scale-t1 x     dev-def456    1h\n`,
    ),
    ['walk1', 'scale-t1'],
  );
  assert.equal(parseDevEnvList(''), null);
  assert.equal(parseDevEnvList('error: something'), null);
});
