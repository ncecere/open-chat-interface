// The watcher and the preflight as processes (tools/scale/lib/cluster-watch.mjs and
// cluster-preflight.mjs), run against a fake `kubectl` on PATH that answers from canned files and
// logs every call. This is the fire drill without a cluster: a threshold forced to 0 aborts the
// run, the run Job is deleted, and every call the tools made stayed in dev-oci and (for the
// preflight) read only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = join(ROOT, 'tools/scale/lib/cluster-watch.mjs');
const PREFLIGHT = join(ROOT, 'tools/scale/lib/cluster-preflight.mjs');
const GIB = 1024 ** 3;

let sandbox;

const FAKE_KUBECTL = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls.log"
args="$*"
if [ -f "$FAKE_DIR/fail-all" ]; then echo "connection refused" >&2; exit 1; fi
case "$args" in
  *"config current-context"*) cat "$FAKE_DIR/context" ;;
  *"get nodes -o json"*) cat "$FAKE_DIR/nodes.json" ;;
  *"get --raw /api/v1/nodes/"*"/proxy/stats/summary"*)
    node="\${args##*/api/v1/nodes/}"; node="\${node%%/*}"; cat "$FAKE_DIR/summary-$node.json" ;;
  *"get --raw /readyz/etcd"*)
    if [ "$(cat "$FAKE_DIR/ready")" = ok ]; then echo ok; else echo "Internal Server Error: etcd failed" >&2; exit 1; fi ;;
  *"get --raw /metrics"*)
    n=$(cat "$FAKE_DIR/scrapes" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_DIR/scrapes"
    for le in 0.005:90 0.025:99 0.1:100 +Inf:100; do
      echo "etcd_request_duration_seconds_bucket{operation=\\"get\\",type=\\"pods\\",le=\\"\${le%%:*}\\"} $((n * \${le##*:}))"
    done ;;
  *"get pv -o"*) cat "$FAKE_DIR/pv.tsv" ;;
  *" exec "*" df -Pk"*) cat "$FAKE_DIR/df.txt" ;;
  *"delete jobs"*) echo "job.batch deleted" ;;
  *) echo "fake kubectl: unexpected call: $args" >&2; exit 99 ;;
esac
`;

const node = (name, { ready = 'True', disk = 'False' } = {}) => ({
  metadata: { name },
  status: {
    capacity: { cpu: '8', memory: '32Gi' },
    conditions: [
      { type: 'MemoryPressure', status: 'False' },
      { type: 'DiskPressure', status: disk },
      { type: 'PIDPressure', status: 'False' },
      { type: 'Ready', status: ready },
    ],
    nodeInfo: {
      kernelVersion: '6.12.43-talos',
      osImage: 'Talos (v1.11.0)',
      architecture: 'amd64',
      kubeletVersion: 'v1.34.0',
    },
  },
});

function reset() {
  const dir = join(sandbox, `fake-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  const write = (name, text) =>
    writeFileSync(join(dir, name), typeof text === 'string' ? text : `${JSON.stringify(text)}\n`);
  write('context', 'admin@bitop-talos\n');
  write('nodes.json', { items: ['talos-cp-1', 'talos-cp-2', 'talos-cp-3'].map((n) => node(n)) });
  for (const name of ['talos-cp-1', 'talos-cp-2', 'talos-cp-3']) {
    write(`summary-${name}.json`, {
      node: {
        cpu: { usageNanoCores: 800_000_000 },
        memory: { availableBytes: 20 * GIB },
        fs: { availableBytes: 600 * GIB, capacityBytes: 930 * GIB, usedBytes: 330 * GIB },
      },
    });
  }
  write('ready', 'ok');
  write('pv.tsv', 'local-dev\t10Gi\ttalos-cp-1\nlocal-dev\t40Gi\ttalos-cp-3\nnfs-dev\t1Ti\t\n');
  write(
    'df.txt',
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/loop3 5242880 1048576 4194304 20% /var/lib/postgresql/data\n',
  );
  write('dev-env', '#!/bin/sh\necho "PROJECT  NAME  REF  IMAGES  EXPIRES IN"\n');
  chmodSync(join(dir, 'dev-env'), 0o755);
  return {
    dir,
    write,
    calls: () =>
      existsSync(join(dir, 'calls.log'))
        ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
        : [],
  };
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'oci-scale-watch-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
  chmodSync(join(bin, 'kubectl'), 0o755);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function run(script, args, f) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      // The fake first: a real kubectl, if this machine has one, is never reached.
      PATH: `${join(sandbox, 'bin')}:/usr/bin:/bin`,
      FAKE_DIR: f.dir,
      SCALE_KUBECONFIG: join(sandbox, 'no-such-kubeconfig'),
      HOME: sandbox,
    },
    timeout: 60_000,
  });
}

const watch = (f, extra = [], samples = '4') =>
  run(
    WATCH,
    [
      '--name',
      'scale-t1',
      '--profile',
      'tiny',
      '--db-node',
      'talos-cp-1',
      '--log',
      join(f.dir, 'watch.jsonl'),
      '--abort-file',
      join(f.dir, 'abort.json'),
      '--interval-seconds',
      '0.05',
      '--max-samples',
      samples,
      ...extra,
    ],
    f,
  );
const lines = (f) =>
  existsSync(join(f.dir, 'watch.jsonl'))
    ? readFileSync(join(f.dir, 'watch.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const abortReasons = (f) =>
  JSON.parse(readFileSync(join(f.dir, 'abort.json'), 'utf8')).reasons.map((r) => r.code);

function assertScoped(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call, /^--kubeconfig \S+ --request-timeout=30s -n dev-oci /, call);
    assert.doesNotMatch(call, /(^|\s)(-A|--all-namespaces)(\s|$)/, call);
    assert.equal([...call.matchAll(/(^|\s)(-n|--namespace)(\s|=)/g)].length, 1, call);
  }
}

test('a quiet cluster: the watcher samples, logs, and never touches the Job', () => {
  const f = reset();
  const result = watch(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lines(f).length, 4);
  assert.ok(!existsSync(join(f.dir, 'abort.json')));
  assert.ok(
    f.calls().every((c) => !/ delete /.test(c)),
    'nothing is deleted without an abort',
  );
  assertScoped(f.calls());
  // The first sample has no earlier scrape to compare with; later ones read the latency.
  assert.equal(lines(f)[0].sample.etcd.p99Ms, null);
  assert.equal(lines(f)[3].sample.etcd.p99Ms, 25);
  assert.equal(lines(f)[3].sample.volume.usedBytes, 1024 ** 3);
});

test('the fire drill: a threshold forced to 0 aborts, deletes the Job first, and exits 3', () => {
  const f = reset();
  const result = watch(f, ['--threshold', 'etcdFsyncAbortOnceMs=0'], '10');
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /WATCHER ABORT/);
  assert.deepEqual(abortReasons(f), ['etcd-fsync-spike']);
  const calls = f.calls();
  assert.ok(
    calls.some((c) =>
      /-n dev-oci delete jobs -l dev\.bitop\.dev\/env=scale-t1 --wait=false/.test(c),
    ),
    'the run Job was deleted',
  );
  assertScoped(calls);
  // It aborted on the second sample, the first that had a latency to read.
  assert.equal(lines(f).length, 2);
});

test('a volume at 80 % of the claim aborts at once', () => {
  const f = reset();
  // 5Gi claim: the limit is 4 GiB; 4194304 KiB is exactly that.
  f.write(
    'df.txt',
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/loop3 5242880 4194304 1048576 80% /var/lib/postgresql/data\n',
  );
  const result = watch(f, [], '10');
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.ok(abortReasons(f).includes('volume'));
  assert.equal(lines(f).length, 1);
});

test('just under the limit does not abort', () => {
  const f = reset();
  f.write(
    'df.txt',
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/loop3 5242880 4194303 1048577 80% /var/lib/postgresql/data\n',
  );
  assert.equal(watch(f).status, 0);
});

test('node pressure, a node that is not Ready, and a failing /readyz/etcd abort', () => {
  let f = reset();
  f.write('nodes.json', {
    items: [node('talos-cp-1'), node('talos-cp-2', { disk: 'True' }), node('talos-cp-3')],
  });
  assert.equal(watch(f).status, 3);
  assert.ok(abortReasons(f).includes('node-pressure'));

  f = reset();
  f.write('nodes.json', {
    items: [node('talos-cp-1'), node('talos-cp-2'), node('talos-cp-3', { ready: 'False' })],
  });
  assert.equal(watch(f).status, 3);

  f = reset();
  f.write('ready', 'failing');
  const result = watch(f);
  assert.equal(result.status, 3);
  assert.ok(abortReasons(f).includes('etcd-readyz'));
});

test('database-node disk at 20 % free aborts', () => {
  const f = reset();
  f.write('summary-talos-cp-1.json', {
    node: {
      cpu: { usageNanoCores: 1 },
      memory: { availableBytes: 1 },
      fs: { availableBytes: 186 * GIB, capacityBytes: 930 * GIB, usedBytes: 744 * GIB },
    },
  });
  assert.equal(watch(f).status, 3);
  assert.ok(abortReasons(f).includes('db-node-fs'));
});

test('a watcher that cannot read anything aborts after three samples', () => {
  const f = reset();
  writeFileSync(join(f.dir, 'fail-all'), '');
  const result = watch(f, [], '10');
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.ok(abortReasons(f).includes('blind'));
  assert.equal(lines(f).length, 3);
});

test('bad options are refused', () => {
  const f = reset();
  assert.equal(watch(f, ['--threshold', 'nonsense=1']).status, 2);
  const missing = run(WATCH, ['--name', 'scale-t1'], f);
  assert.equal(missing.status, 2);
});

// --- Preflight ----------------------------------------------------------------------------------

const preflight = (f, extra = []) =>
  run(
    PREFLIGHT,
    [
      'run',
      '--profile',
      'tiny',
      '--name',
      'scale-t1',
      '--db-node',
      'talos-cp-1',
      '--load-node',
      'talos-cp-3',
      '--window-seconds',
      '1',
      '--interval-seconds',
      '0.2',
      '--dev-env',
      join(f.dir, 'dev-env'),
      '--out',
      join(f.dir, 'preflight.json'),
      ...extra,
    ],
    f,
  );

test('preflight passes on a quiet cluster, prints what it read, and only reads', () => {
  const f = reset();
  const result = preflight(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const id of [
    'context',
    'environments',
    'nodes',
    'pool',
    'db-node-fs',
    'cpu',
    'etcd',
    'etcd-fsync',
  ]) {
    assert.match(result.stdout, new RegExp(`\\[ok\\] ${id}:`), id);
  }
  assert.match(result.stdout, /Preflight passed/);
  const saved = JSON.parse(readFileSync(join(f.dir, 'preflight.json'), 'utf8'));
  assert.equal(saved.decision.ok, true);
  assert.equal(saved.poolBeforeBytes, 10 * GIB);
  const calls = f.calls();
  assertScoped(calls);
  for (const call of calls) {
    assert.match(call, / (config current-context|get nodes|get --raw|get pv)/, `a read: ${call}`);
    assert.doesNotMatch(call, / (apply|create|patch|delete|scale|set|label|annotate|exec) /, call);
  }
});

test('preflight stops, and says why, when a node is under pressure or the context is wrong', () => {
  let f = reset();
  f.write('nodes.json', {
    items: [node('talos-cp-1'), node('talos-cp-2', { disk: 'True' }), node('talos-cp-3')],
  });
  let result = preflight(f);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] nodes:/);
  assert.match(result.stdout, /nothing was created/);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'preflight.json'), 'utf8')).decision.ok, false);

  f = reset();
  f.write('context', 'minikube\n');
  result = preflight(f);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] context:/);
});

test('preflight stops on another environment, a full pool, or etcd not ready', () => {
  let f = reset();
  f.write(
    'dev-env',
    '#!/bin/sh\necho "PROJECT  NAME  REF  IMAGES  EXPIRES IN"\necho "oci  walk1  main  dev-abc  3h"\n',
  );
  let result = preflight(f);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] environments: .*walk1/);

  f = reset();
  f.write('pv.tsv', 'local-dev\t198Gi\ttalos-cp-1\n');
  result = preflight(f);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] pool:/);

  f = reset();
  f.write('ready', 'failing');
  result = preflight(f);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] etcd:/);
});

test('preflight cannot pass when the cluster cannot be read', () => {
  const f = reset();
  writeFileSync(join(f.dir, 'fail-all'), '');
  const result = preflight(f);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /\[ok\] (nodes|pool|cpu|etcd)/);
});

test('the pool command prints the bytes allocated on one node', () => {
  const f = reset();
  const result = run(PREFLIGHT, ['pool', '--db-node', 'talos-cp-3'], f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), String(40 * GIB));
});
