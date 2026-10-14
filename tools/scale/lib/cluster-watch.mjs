#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a command line tool whose output cluster.sh logs.
/**
 * The watcher of a cluster run (docs/dev/scale-harness.md, "Large on the cluster"): every 15 s
 * until it is stopped it reads etcd latency, readiness and leader changes, the database volume's
 * use and the nodes' conditions, applies the thresholds of cluster-guard.mjs, and on an abort
 * deletes the run Job first (that stops the writes) and exits 3. cluster.sh then tears down.
 *
 *   cluster-watch.mjs --name N --profile P --db-node NODE --log FILE --abort-file FILE
 *                     [--interval-seconds 15] [--threshold name=value]... [--etcd-metrics-cmd CMD]
 *                     [--max-samples N]
 *
 * Exit status: 0 stopped (SIGTERM, SIGINT or --max-samples), 3 aborted the run, 2 misused.
 * Needs SCALE_KUBECONFIG. Every kubectl call goes through the scope guard.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createWatcher,
  parseQuantity,
  parseThresholdOverrides,
  planFor,
  proxyThresholdsFromBaseline,
  thresholdsFor,
} from './cluster-guard.mjs';
import {
  etcdSignal,
  kubectl,
  readEtcdReady,
  readMetricsText,
  readNodes,
  readSummary,
  readVolume,
} from './cluster-kube.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    profile: { type: 'string' },
    'db-node': { type: 'string' },
    log: { type: 'string' },
    'abort-file': { type: 'string' },
    'interval-seconds': { type: 'string', default: '15' },
    threshold: { type: 'string', multiple: true, default: [] },
    'etcd-metrics-cmd': { type: 'string' },
    'max-samples': { type: 'string' },
    'baseline-file': { type: 'string' },
  },
});
for (const required of ['name', 'profile', 'db-node', 'log', 'abort-file']) {
  if (!values[required]) {
    console.error(`--${required} is required`);
    process.exit(2);
  }
}

const name = values.name;
const dbNode = values['db-node'];
const interval = Number(values['interval-seconds']);
const maxSamples = values['max-samples'] ? Number(values['max-samples']) : Number.POSITIVE_INFINITY;
const command = values['etcd-metrics-cmd'];
const source = command ? 'wal-fsync' : 'apiserver-request';
let thresholds;
try {
  // The apiserver-latency proxy follows the idle baseline the preflight measured (fixed limits
  // would abort an idle cluster); etcd's own metric keeps its absolute limits. A forced
  // threshold (the fire drill) wins over both.
  const derived =
    source === 'apiserver-request' && values['baseline-file']
      ? proxyThresholdsFromBaseline(
          JSON.parse(readFileSync(values['baseline-file'], 'utf8')).readings.etcd.fsyncP99Ms,
        )
      : {};
  thresholds = {
    ...thresholdsFor(source),
    ...derived,
    ...parseThresholdOverrides(values.threshold),
  };
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const watcher = createWatcher({
  thresholds,
  pgSizeBytes: parseQuantity(planFor(values.profile).pgSize),
  dbNode,
});

let previousMetrics = null;

function takeSample() {
  const nodes = readNodes() ?? [];
  const dbSummary = readSummary(dbNode);
  const entries = nodes.map((node) => ({
    name: node.name,
    ready: node.ready,
    pressure: node.pressure,
    fsFreeFraction:
      node.name === dbNode && dbSummary?.fsCapacityBytes
        ? dbSummary.fsAvailableBytes / dbSummary.fsCapacityBytes
        : undefined,
  }));
  const text = readMetricsText(command);
  const signal = etcdSignal(previousMetrics, text);
  if (text !== null) previousMetrics = text;
  const matches = signal.source === source;
  return {
    etcd: {
      p99Ms: matches ? signal.p99Ms : null,
      leaderChanges: matches ? signal.leaderChanges : null,
      readyz: readEtcdReady(),
    },
    volume: { usedBytes: readVolume(name)?.usedBytes ?? null },
    nodes: entries,
  };
}

function stop(status) {
  process.exit(status);
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
process.on('SIGHUP', () => stop(0));

function abortRun(result) {
  const reasons = result.reasons.map((r) => `${r.code}: ${r.detail}`);
  console.log(`WATCHER ABORT: ${reasons.join('; ')}`);
  // Stop the writes first: the Job is what writes. Teardown follows from cluster.sh.
  const deleted = kubectl(
    ['delete', 'jobs', '-l', `dev.bitop.dev/env=${name}`, '--wait=false', '--ignore-not-found'],
    { env: name },
  );
  console.log(`  deleted the run Job (kubectl status ${deleted.status})`);
  writeFileSync(
    values['abort-file'],
    `${JSON.stringify({ at: new Date().toISOString(), reasons: result.reasons })}\n`,
  );
  stop(3);
}

console.log(
  `Watcher for ${name}: every ${interval} s, etcd source ${source}, thresholds ${JSON.stringify(thresholds)}`,
);
for (let count = 0; count < maxSamples; count++) {
  const sample = takeSample();
  const result = watcher.evaluate(sample);
  appendFileSync(
    values.log,
    `${JSON.stringify({ at: new Date().toISOString(), action: result.action, reasons: result.reasons, sample })}\n`,
  );
  if (result.action === 'abort') abortRun(result);
  if (result.action === 'warn')
    console.log(`  warn: ${result.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ')}`);
  if (count + 1 < maxSamples) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
}
stop(0);
