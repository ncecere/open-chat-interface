#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a command line tool whose output cluster.sh prints.
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone tool, never a Turbo task.
/**
 * Read-only preflight before `dev-env up` (docs/dev/scale-harness.md, "Large on the cluster"):
 * reads the cluster, prints what it read and each decision, and exits 1 on any miss. It creates
 * nothing. Every kubectl call goes through the scope guard.
 *
 *   cluster-preflight.mjs run  --profile P --name N --db-node NODE --load-node NODE
 *                              [--window-seconds S] [--interval-seconds 15] [--context-pattern RE]
 *                              [--etcd-metrics-cmd CMD] [--dev-env PATH] [--out FILE]
 *   cluster-preflight.mjs pool --db-node NODE      bytes of the local-dev pool allocated there
 *
 * Needs SCALE_KUBECONFIG (cluster.sh sets it). The window is how long it samples node CPU and etcd
 * latency: 900 s for medium and large (the spec's 15 minutes, which also covers its 5 for etcd), 60 s
 * for tiny and small.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  decidePreflight,
  PREFLIGHT_LIMITS,
  parseQuantity,
  planFor,
  thresholdsFor,
} from './cluster-guard.mjs';
import {
  etcdSignal,
  readContext,
  readEtcdReady,
  readMetricsText,
  readNodes,
  readPoolAllocated,
  readSummary,
} from './cluster-kube.mjs';
import { cpuBusyFraction, parseDevEnvList } from './cluster-sample.mjs';

// Project quota of the local-dev pool per node (homelab nodes.yaml, as the spec reads it).
const POOL_CAPACITY_BYTES = { 'talos-cp-1': 200 * 1024 ** 3, 'talos-cp-3': 200 * 1024 ** 3 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    name: { type: 'string' },
    'db-node': { type: 'string' },
    'load-node': { type: 'string' },
    'window-seconds': { type: 'string' },
    'interval-seconds': { type: 'string', default: '15' },
    'context-pattern': { type: 'string', default: 'bitop' },
    'etcd-metrics-cmd': { type: 'string' },
    'dev-env': { type: 'string' },
    out: { type: 'string' },
  },
});

function readEnvironments(devEnv) {
  try {
    return parseDevEnvList(
      execFileSync(devEnv, ['list', 'oci'], { encoding: 'utf8', timeout: 60_000 }),
    );
  } catch {
    return null;
  }
}

async function run() {
  const profile = values.profile;
  const plan = planFor(profile);
  const dbNode = values['db-node'];
  const loadNode = values['load-node'];
  const interval = Number(values['interval-seconds']);
  const windowSeconds = Number(values['window-seconds'] ?? (plan.pinRequired ? 900 : 60));
  const etcdCommand = values['etcd-metrics-cmd'];
  const source = etcdCommand ? 'wal-fsync' : 'apiserver-request';
  const etcdWarnMs = thresholdsFor(source).etcdFsyncWarnMs;

  console.log(
    `Preflight for ${profile} (${plan.pgSize} volume on ${dbNode}, load on ${loadNode}); sampling for ${windowSeconds} s`,
  );
  const readings = {
    context: readContext(),
    environments: readEnvironments(values['dev-env']),
    nodes: readNodes(),
    pool: null,
    etcd: { readyz: readEtcdReady(), members: null, fsyncP99Ms: null },
  };
  const allocated = readPoolAllocated(dbNode);
  if (allocated !== null && dbNode in POOL_CAPACITY_BYTES) {
    readings.pool = { allocatedBytes: allocated, capacityBytes: POOL_CAPACITY_BYTES[dbNode] };
  }

  // Sample node CPU and etcd latency over the window.
  const cpu = { [dbNode]: [], [loadNode]: [] };
  const fsyncSamples = [];
  let previousMetrics = null;
  const deadline = Date.now() + windowSeconds * 1000;
  for (;;) {
    for (const node of [dbNode, loadNode]) {
      const summary = readSummary(node);
      cpu[node].push(summary?.cpuNanoCores ?? null);
      if (node === dbNode && summary) readings.dbSummary = summary;
    }
    const text = readMetricsText(etcdCommand);
    const signal = etcdSignal(previousMetrics, text);
    if (text !== null && signal.source === source && signal.p99Ms !== null)
      fsyncSamples.push(signal.p99Ms);
    if (text !== null) previousMetrics = text;
    if (Date.now() + interval * 1000 > deadline) break;
    await sleep(interval * 1000);
  }
  readings.etcd.fsyncP99Ms = fsyncSamples;
  readings.etcd.readyz = readEtcdReady();

  const nodes = readings.nodes ?? [];
  for (const node of nodes) {
    const samples = cpu[node.name];
    node.cpuBusyFraction = samples ? cpuBusyFraction(samples, node.cpuCores) : null;
    if (node.name === dbNode && readings.dbSummary) {
      node.fsFreeBytes = readings.dbSummary.fsAvailableBytes;
      node.fsCapacityBytes = readings.dbSummary.fsCapacityBytes;
    }
  }

  const decision = decidePreflight(readings, {
    dbNode,
    loadNode,
    pgSizeBytes: parseQuantity(plan.pgSize),
    contextPattern: new RegExp(values['context-pattern']),
    limits: {
      ...PREFLIGHT_LIMITS,
      minEtcdSamples: Math.max(3, Math.floor(windowSeconds / interval) - 2),
    },
    etcdWarnMs,
  });
  for (const check of decision.checks)
    console.log(`  [${check.ok ? 'ok' : 'FAIL'}] ${check.id}: ${check.detail}`);
  console.log(
    `  etcd latency source: ${source}${etcdCommand ? ' (command supplied)' : " (the apiserver's request latency to etcd, a proxy)"}`,
  );
  for (const node of nodes) {
    console.log(
      `  node ${node.name}: ${node.cpuCores} CPUs, ${Math.round((node.memoryBytes ?? 0) / 1024 ** 3)} GiB memory`,
    );
  }
  if (values.out) {
    writeFileSync(
      values.out,
      `${JSON.stringify({ at: new Date().toISOString(), profile, dbNode, loadNode, windowSeconds, source, poolBeforeBytes: readings.pool?.allocatedBytes ?? null, readings: { ...readings, dbSummary: undefined }, decision }, null, 2)}\n`,
    );
  }
  console.log(decision.ok ? 'Preflight passed.' : 'Preflight FAILED: nothing was created.');
  process.exit(decision.ok ? 0 : 1);
}

const command = positionals[0];
if (command === 'run') await run();
else if (command === 'pool') {
  const bytes = readPoolAllocated(values['db-node']);
  if (bytes === null) {
    console.error('the pool allocation could not be read');
    process.exit(1);
  }
  console.log(String(bytes));
} else {
  console.error('Usage: cluster-preflight.mjs run|pool [options] (see the header)');
  process.exit(2);
}
