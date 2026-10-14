// Decisions of `tools/scale/cluster.sh` (docs/dev/scale-harness.md, "Large on the cluster"):
// the scope guard, the pin check, the preflight, the watcher's thresholds and the teardown check.
// Everything here is pure: no cluster, no kubectl. The samples are synthetic, shaped like the
// kubelet summary, Prometheus text and `kubectl get node -o json` that the sampler reads; they are
// not recordings of the real cluster.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWatcher,
  DB_NODES,
  DEFAULT_THRESHOLDS,
  decidePreflight,
  decideTeardown,
  FORBIDDEN_DB_NODE,
  jobDeadlineSeconds,
  NAMESPACE,
  PROXY_PREFLIGHT_CEILING_MS,
  parseQuantity,
  parseThresholdOverrides,
  pinDecision,
  planFor,
  proxyThresholdsFromBaseline,
  ScopeError,
  scopeKubectl,
  thresholdsFor,
} from '../tools/scale/lib/cluster-guard.mjs';

const GIB = 1024 ** 3;
const ENV = 'scale-t1';

// --- Scope guard --------------------------------------------------------------------------

test('every kubectl call gets -n dev-oci, first', () => {
  assert.equal(NAMESPACE, 'dev-oci');
  assert.deepEqual(scopeKubectl(['get', 'pods']), ['-n', 'dev-oci', 'get', 'pods']);
  assert.deepEqual(scopeKubectl(['get', 'pods', '-l', `dev.bitop.dev/env=${ENV}`, '-o', 'name']), [
    '-n',
    'dev-oci',
    'get',
    'pods',
    '-l',
    `dev.bitop.dev/env=${ENV}`,
    '-o',
    'name',
  ]);
});

test('refuses -A and --all-namespaces in every spelling', () => {
  for (const flag of ['-A', '--all-namespaces', '--all-namespaces=true', '-Aw']) {
    assert.throws(() => scopeKubectl(['get', 'pods', flag]), /all namespaces/i, flag);
  }
});

test('refuses any namespace but dev-oci, in every spelling', () => {
  const others = ['open-chat-interface', 'kube-system', 'default', 'dev-grounded', 'dev-oci2'];
  for (const ns of others) {
    assert.throws(() => scopeKubectl(['get', 'pods', '-n', ns]), /namespace/i, `-n ${ns}`);
    assert.throws(() => scopeKubectl(['get', 'pods', `-n${ns}`]), /namespace/i, `-n${ns}`);
    assert.throws(() => scopeKubectl(['get', 'pods', '--namespace', ns]), /namespace/i, ns);
    assert.throws(() => scopeKubectl(['get', 'pods', `--namespace=${ns}`]), /namespace/i, ns);
  }
  assert.throws(() => scopeKubectl(['get', 'pods', '-n']), /namespace/i);
  assert.throws(() => scopeKubectl(['get', 'pods', '-n', '']), /namespace/i);
});

test('an explicit -n dev-oci is accepted once, not duplicated', () => {
  assert.deepEqual(scopeKubectl(['get', 'pods', '-n', 'dev-oci']), [
    '-n',
    'dev-oci',
    'get',
    'pods',
  ]);
  assert.deepEqual(scopeKubectl(['get', 'pods', '--namespace=dev-oci']), [
    '-n',
    'dev-oci',
    'get',
    'pods',
  ]);
});

test('refuses reading namespaces, and flags that change the target cluster or identity', () => {
  for (const target of [
    'ns',
    'namespace',
    'namespaces',
    'namespace/open-chat-interface',
    'pods,ns',
  ]) {
    assert.throws(() => scopeKubectl(['get', target]), /namespace/i, target);
  }
  for (const flag of [
    ['--context', 'prod'],
    ['--context=prod'],
    ['--kubeconfig', '/tmp/x'],
    ['--server=https://example.test'],
    ['-s', 'https://example.test'],
    ['--token=abc'],
    ['--as', 'admin'],
    ['--cluster=other'],
    ['--user=other'],
  ]) {
    assert.throws(() => scopeKubectl(['get', 'pods', ...flag]), /not allowed/i, flag.join(' '));
  }
});

test('only the verbs the run needs are allowed', () => {
  for (const verb of [
    'drain',
    'cordon',
    'taint',
    'edit',
    'replace',
    'proxy',
    'port-forward',
    'debug',
  ]) {
    assert.throws(() => scopeKubectl([verb, 'x']), /verb/i, verb);
  }
  for (const verb of ['get', 'describe', 'logs', 'top', 'wait', 'exec', 'cp']) {
    assert.doesNotThrow(() => scopeKubectl([verb, `${ENV}-pg-1`]), verb);
  }
  assert.throws(() => scopeKubectl([]), /verb/i);
  assert.throws(() => scopeKubectl(['-o', 'json', 'get', 'pods']), /verb/i);
});

test('the only kubectl config command is current-context', () => {
  assert.deepEqual(scopeKubectl(['config', 'current-context']), [
    '-n',
    'dev-oci',
    'config',
    'current-context',
  ]);
  for (const args of [['config', 'view'], ['config', 'use-context', 'x'], ['config']]) {
    assert.throws(() => scopeKubectl(args), /config/i, args.join(' '));
  }
});

test('get --raw reaches only the readiness, metrics and kubelet summary paths', () => {
  for (const path of [
    '/readyz/etcd',
    '/readyz',
    '/metrics',
    '/api/v1/nodes/talos-cp-3/proxy/stats/summary',
  ]) {
    assert.doesNotThrow(() => scopeKubectl(['get', '--raw', path]), path);
  }
  for (const path of [
    '/api/v1/namespaces/open-chat-interface/pods',
    '/api/v1/namespaces/dev-oci/secrets',
    '/api/v1/nodes/talos-cp-3/proxy/configz',
    '/api/v1/secrets',
    '/apis/apps/v1/deployments',
    '/api/v1/nodes/../namespaces',
  ]) {
    assert.throws(() => scopeKubectl(['get', '--raw', path]), /raw/i, path);
  }
  assert.throws(() => scopeKubectl(['get', 'pods', '--raw=/metrics', '--raw', '/x']), /raw/i);
  assert.throws(() => scopeKubectl(['describe', 'pods', '--raw', '/metrics']), /raw/i);
});

test('delete needs the environment label or names that start with the environment', () => {
  const opts = { env: ENV };
  assert.doesNotThrow(() =>
    scopeKubectl(['delete', 'jobs', '-l', `dev.bitop.dev/env=${ENV}`], opts),
  );
  assert.doesNotThrow(() =>
    scopeKubectl(['delete', 'job', `${ENV}-scale-run`, '--ignore-not-found'], opts),
  );
  assert.doesNotThrow(() => scopeKubectl(['delete', `job/${ENV}-scale-run`], opts));
  for (const args of [
    ['delete', 'jobs', '--all'],
    ['delete', 'jobs', '-l', 'dev.bitop.dev/env=other'],
    ['delete', 'jobs', '-l', 'app=x'],
    ['delete', 'job', 'scale-run'],
    ['delete', 'job', 'other-env-scale-run'],
    ['delete', 'pods'],
    ['delete', 'job/other-scale-run'],
  ]) {
    assert.throws(() => scopeKubectl(args, opts), /delete|environment/i, args.join(' '));
  }
  assert.throws(() => scopeKubectl(['delete', 'job', `${ENV}-scale-run`]), /environment/i);
});

test('other changes name only objects of the environment', () => {
  const opts = { env: ENV };
  const ok = [
    ['patch', 'cluster.postgresql.cnpg.io', `${ENV}-pg`, '--type', 'merge', '-p', '{"spec":{}}'],
    ['scale', `deployment/${ENV}-open-chat-interface-api`, '--replicas=0'],
    ['set', 'env', `deployment/${ENV}-open-chat-interface-api`, 'RATE_LIMIT=1'],
    ['set', 'resources', `deployment/${ENV}-open-chat-interface-api`, '--limits=cpu=2'],
    ['rollout', 'status', `deployment/${ENV}-open-chat-interface-api`, '--timeout=300s'],
    ['label', 'configmap', `${ENV}-scale-tools`, 'dev.bitop.dev/env=scale-t1', '--overwrite'],
    ['create', 'configmap', `${ENV}-scale-tools`, '--from-file=scale.tgz=/tmp/s.tgz'],
    ['apply', '-f', '-'],
  ];
  for (const args of ok) assert.doesNotThrow(() => scopeKubectl(args, opts), args.join(' '));
  const bad = [
    ['patch', 'deployment', 'open-chat-redis', '-p', '{}'],
    ['scale', 'deployment/some-production-api', '--replicas=0'],
    ['set', 'env', 'deployment/web', 'A=b'],
    ['label', 'node', 'talos-cp-3', 'x=y'],
    ['create', 'configmap', 'other-scale-tools'],
    ['annotate', 'configmap', 'env-other', 'a=b'],
  ];
  for (const args of bad)
    assert.throws(() => scopeKubectl(args, opts), /environment/i, args.join(' '));
});

test('exec, logs and cp reach only pods of the environment', () => {
  const opts = { env: ENV };
  const ok = [
    ['exec', `${ENV}-pg-1`, '-c', 'postgres', '--', 'psql', '-U', 'postgres', '-c', 'select 1'],
    // Everything after -- is the command run inside the pod, not kubectl's own flags.
    [
      'exec',
      `${ENV}-pg-1`,
      '-c',
      'postgres',
      '--',
      'psql',
      '-U',
      'postgres',
      '-Atc',
      'show max_connections',
    ],
    ['exec', `${ENV}-pg-1`, '--', 'df', '-Pk', '/var/lib/postgresql/data'],
    ['logs', `${ENV}-scale-run-abc12`, '-c', 'generate'],
    ['logs', '-l', `dev.bitop.dev/env=${ENV}`],
    ['cp', `${ENV}-scale-run-abc12:/results`, '/tmp/out', '-c', 'hold'],
  ];
  for (const args of ok) assert.doesNotThrow(() => scopeKubectl(args, opts), args.join(' '));
  const bad = [
    ['exec', 'other-pg-1', '--', 'id'],
    ['exec', '-A', `${ENV}-pg-1`, '--', 'id'],
    ['exec', `${ENV}-pg-1`, '-n', 'kube-system', '--', 'id'],
    ['exec', 'open-chat-api-0', '--', 'id'],
    ['logs', 'other-scale-run-abc12'],
    ['logs', '-l', 'app=x'],
    ['cp', 'other-pod:/results', '/tmp/out'],
    ['cp', '/tmp/a', '/tmp/b'],
    ['cp', `${ENV}-pg-1:/x`, 'other-pod:/y'],
  ];
  for (const args of bad) assert.throws(() => scopeKubectl(args, opts), ScopeError, args.join(' '));
});

test('refuses arguments with line breaks or NUL', () => {
  assert.throws(() => scopeKubectl(['get', 'pods\n-A']), /control/i);
  assert.throws(() => scopeKubectl(['get', 'pods\0']), /control/i);
  assert.throws(() => scopeKubectl(['get', 7]), /string/i);
});

// --- Pin ----------------------------------------------------------------------------------

test('the database node is cp-1 or cp-3, never cp-2', () => {
  assert.deepEqual(DB_NODES, ['talos-cp-1', 'talos-cp-3']);
  assert.equal(FORBIDDEN_DB_NODE, 'talos-cp-2');
  assert.equal(pinDecision({ profile: 'large', requestedNode: 'talos-cp-3' }).ok, true);
  assert.equal(pinDecision({ profile: 'tiny', requestedNode: 'talos-cp-1' }).ok, true);
  for (const node of ['talos-cp-2', 'talos-cp-4', 'worker-1', '', undefined]) {
    const decision = pinDecision({ profile: 'medium', requestedNode: node });
    assert.equal(decision.ok, false, String(node));
  }
  assert.match(
    pinDecision({ profile: 'large', requestedNode: 'talos-cp-2' }).problems.join(' '),
    /talos-cp-2/,
  );
});

test('medium and large need a pin; tiny and small may leave it to the default', () => {
  assert.equal(pinDecision({ profile: 'tiny' }).ok, true);
  assert.equal(pinDecision({ profile: 'small' }).ok, true);
  assert.equal(pinDecision({ profile: 'medium' }).ok, false);
  assert.equal(pinDecision({ profile: 'large' }).ok, false);
  assert.equal(pinDecision({ profile: 'tiny', requestedNode: 'talos-cp-2' }).ok, false);
});

test('after the database starts, the bound volume node must be the pinned one', () => {
  const bound = (boundNode, profile = 'large', requestedNode = 'talos-cp-3') =>
    pinDecision({ profile, requestedNode, boundNode, phase: 'bound' });
  assert.equal(bound('talos-cp-3').ok, true);
  assert.equal(bound('talos-cp-1').ok, false);
  assert.equal(bound('talos-cp-2').ok, false);
  assert.match(bound('talos-cp-2').problems.join(' '), /talos-cp-2/);
  // Not being able to read the node is not a pass.
  assert.equal(bound(undefined).ok, false);
  assert.equal(bound('').ok, false);
  assert.equal(bound(null, 'tiny', 'talos-cp-1').ok, false);
});

// --- Profiles, quantities, deadlines ------------------------------------------------------

test('profile plan: volume sizes and TTLs from the spec', () => {
  assert.deepEqual(
    ['tiny', 'small', 'medium', 'large'].map((p) => [planFor(p).pgSize, planFor(p).ttlHours]),
    [
      ['5Gi', 2],
      ['15Gi', 3],
      ['40Gi', 4],
      ['150Gi', 8],
    ],
  );
  assert.throws(() => planFor('huge'), /profile/i);
});

test('the Job deadline is the TTL minus 30 minutes', () => {
  assert.equal(jobDeadlineSeconds(2), 5400);
  assert.equal(jobDeadlineSeconds(8), 27_000);
  assert.throws(() => jobDeadlineSeconds(0.5), /ttl/i);
});

test('parseQuantity reads binary sizes', () => {
  assert.equal(parseQuantity('150Gi'), 150 * GIB);
  assert.equal(parseQuantity('5Gi'), 5 * GIB);
  assert.equal(parseQuantity('512Mi'), 512 * 1024 ** 2);
  assert.equal(parseQuantity('2Ti'), 2 * 1024 ** 4);
  assert.equal(parseQuantity('1024'), 1024);
  for (const bad of ['', 'Gi', '1.5Gi', '10G', '-1Gi', 'abc', undefined]) {
    assert.throws(() => parseQuantity(bad), /quantity/i, String(bad));
  }
});

// --- Preflight ----------------------------------------------------------------------------

function goodReadings() {
  const node = (name) => ({
    name,
    ready: true,
    pressure: { memory: false, disk: false, pid: false },
    cpuBusyFraction: 0.2,
    fsFreeBytes: 600 * GIB,
    fsCapacityBytes: 930 * GIB,
  });
  return {
    context: 'admin@bitop-talos',
    environments: [],
    nodes: [node('talos-cp-1'), node('talos-cp-2'), node('talos-cp-3')],
    pool: { allocatedBytes: 10 * GIB, capacityBytes: 200 * GIB },
    etcd: { readyz: true, members: null, fsyncP99Ms: Array.from({ length: 10 }, () => 3.2) },
  };
}
const preflightOptions = (extra = {}) => ({
  profile: 'large',
  dbNode: 'talos-cp-3',
  loadNode: 'talos-cp-1',
  pgSizeBytes: 150 * GIB,
  contextPattern: /bitop/,
  ...extra,
});
const failed = (decision) => decision.checks.filter((c) => !c.ok).map((c) => c.id);

test('preflight passes on a quiet cluster and prints what it read', () => {
  const decision = decidePreflight(goodReadings(), preflightOptions());
  assert.equal(decision.ok, true);
  assert.deepEqual(failed(decision), []);
  assert.ok(decision.checks.length >= 8);
  for (const check of decision.checks) assert.ok(check.detail.length > 0, check.id);
});

test('preflight stops on a wrong context, another environment, or an unready node', () => {
  let r = goodReadings();
  r.context = 'minikube';
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['context']);

  r = goodReadings();
  r.environments = ['someone-else'];
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['environments']);

  r = goodReadings();
  r.nodes[1].ready = false;
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['nodes']);

  for (const kind of ['memory', 'disk', 'pid']) {
    r = goodReadings();
    r.nodes[0].pressure[kind] = true;
    assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['nodes'], kind);
  }

  r = goodReadings();
  r.nodes = r.nodes.filter((n) => n.name !== 'talos-cp-3');
  // The readings that depend on that node fail with it.
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['nodes', 'db-node-fs', 'cpu']);
});

test('pool: allocated plus the request may reach 0.80 of the quota, not more', () => {
  const at = (allocatedGiB, extra) => {
    const r = goodReadings();
    r.pool = { allocatedBytes: allocatedGiB * GIB, capacityBytes: 200 * GIB };
    return decidePreflight(r, preflightOptions(extra));
  };
  // 150 Gi requested: 10 Gi allocated makes exactly 160 / 200 = 0.80.
  assert.equal(at(10).ok, true);
  assert.equal(at(10.5).ok, false);
  assert.deepEqual(failed(at(11)), ['pool']);
  // A small run has room that a large one lacks.
  assert.equal(at(100, { profile: 'small', pgSizeBytes: 15 * GIB }).ok, true);
});

test('database-node filesystem: at least 20 % stays free after the request', () => {
  const at = (freeGiB) => {
    const r = goodReadings();
    for (const n of r.nodes) {
      n.fsCapacityBytes = 1000 * GIB;
      n.fsFreeBytes = freeGiB * GIB;
    }
    return decidePreflight(r, preflightOptions());
  };
  // 150 Gi requested of 1000 Gi: free 350 leaves exactly 200 = 20 %.
  assert.equal(at(350).ok, true);
  assert.deepEqual(failed(at(349)), ['db-node-fs']);
});

test('CPU: both nodes must average below 50 % busy', () => {
  const at = (busy, name = 'talos-cp-3') => {
    const r = goodReadings();
    r.nodes.find((n) => n.name === name).cpuBusyFraction = busy;
    return decidePreflight(r, preflightOptions());
  };
  assert.equal(at(0.4999).ok, true);
  assert.deepEqual(failed(at(0.5)), ['cpu']);
  assert.deepEqual(failed(at(0.9, 'talos-cp-1')), ['cpu']);
  // The node that is neither the database nor the load node is not part of the run.
  assert.equal(at(0.9, 'talos-cp-2').ok, true);
});

test('etcd: not ready, or any sample at the warning level in the window, stops the run', () => {
  let r = goodReadings();
  r.etcd.readyz = false;
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['etcd']);

  r = goodReadings();
  r.etcd.members = [
    { name: 'a', healthy: true },
    { name: 'b', healthy: false },
  ];
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['etcd']);

  r = goodReadings();
  r.etcd.fsyncP99Ms[4] = 9.99;
  assert.equal(decidePreflight(r, preflightOptions()).ok, true);
  r.etcd.fsyncP99Ms[4] = 10;
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['etcd-fsync']);

  r = goodReadings();
  r.etcd.fsyncP99Ms = [1, 1, 1];
  assert.deepEqual(failed(decidePreflight(r, preflightOptions())), ['etcd-fsync']);
});

test('a reading that could not be taken is a failure, never a pass', () => {
  const broken = [
    (r) => {
      r.context = null;
    },
    (r) => {
      r.environments = null;
    },
    (r) => {
      r.pool = null;
    },
    (r) => {
      r.etcd = null;
    },
    (r) => {
      r.etcd.readyz = null;
    },
    (r) => {
      r.etcd.fsyncP99Ms = null;
    },
    (r) => {
      r.nodes[2].cpuBusyFraction = null;
    },
    (r) => {
      r.nodes[2].fsFreeBytes = null;
    },
    (r) => {
      r.nodes[2].pressure = null;
    },
  ];
  for (const [index, mutate] of broken.entries()) {
    const r = goodReadings();
    mutate(r);
    assert.equal(decidePreflight(r, preflightOptions()).ok, false, `case ${index}`);
  }
});

// --- Thresholds ---------------------------------------------------------------------------

test('starting thresholds are the spec values', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    etcdFsyncWarnMs: 10,
    etcdFsyncAbortMs: 25,
    etcdFsyncStrikes: 2,
    etcdFsyncAbortOnceMs: 100,
    volumeAbortFraction: 0.8,
    dbNodeFsFreeMinFraction: 0.2,
    maxBlindSamples: 3,
  });
  assert.deepEqual(thresholdsFor('wal-fsync'), DEFAULT_THRESHOLDS);
});

test('the apiserver proxy has its own, looser latency thresholds', () => {
  const proxy = thresholdsFor('apiserver-request');
  assert.ok(proxy.etcdFsyncWarnMs > DEFAULT_THRESHOLDS.etcdFsyncWarnMs);
  assert.ok(proxy.etcdFsyncAbortMs > DEFAULT_THRESHOLDS.etcdFsyncAbortMs);
  assert.ok(proxy.etcdFsyncAbortOnceMs > DEFAULT_THRESHOLDS.etcdFsyncAbortOnceMs);
  assert.equal(proxy.volumeAbortFraction, DEFAULT_THRESHOLDS.volumeAbortFraction);
  assert.throws(() => thresholdsFor('guess'), /source/i);
});

test('overrides (the fire drill) must name a known threshold and a number', () => {
  assert.deepEqual(parseThresholdOverrides(['etcdFsyncAbortOnceMs=0', 'volumeAbortFraction=0.5']), {
    etcdFsyncAbortOnceMs: 0,
    volumeAbortFraction: 0.5,
  });
  assert.deepEqual(parseThresholdOverrides([]), {});
  for (const bad of [
    'nonsense=1',
    'etcdFsyncAbortMs',
    'etcdFsyncAbortMs=abc',
    'etcdFsyncAbortMs=-1',
  ]) {
    assert.throws(() => parseThresholdOverrides([bad]), /threshold/i, bad);
  }
});

// --- Watcher ------------------------------------------------------------------------------

const VOLUME_LIMIT = 120 * GIB; // 80 % of 150 Gi

function watcher(extra = {}) {
  return createWatcher({
    thresholds: DEFAULT_THRESHOLDS,
    volumeLimitBytes: VOLUME_LIMIT,
    dbNode: 'talos-cp-3',
    ...extra,
  });
}
function sample(extra = {}) {
  const base = {
    etcd: { p99Ms: 3, readyz: true, leaderChanges: 4 },
    volume: { usedBytes: 20 * GIB },
    nodes: [
      {
        name: 'talos-cp-3',
        ready: true,
        pressure: { memory: false, disk: false, pid: false },
        fsFreeFraction: 0.6,
      },
      {
        name: 'talos-cp-1',
        ready: true,
        pressure: { memory: false, disk: false, pid: false },
        fsFreeFraction: 0.6,
      },
    ],
  };
  return { ...base, ...extra };
}
const withP99 = (p99Ms, leaderChanges = 4, readyz = true) =>
  sample({ etcd: { p99Ms, readyz, leaderChanges } });
const codes = (result) => result.reasons.map((r) => r.code);

test('a quiet sample is ok and a sample near the warning level only warns', () => {
  const w = watcher();
  assert.equal(w.evaluate(sample()).action, 'ok');
  assert.equal(w.evaluate(withP99(9.99)).action, 'ok');
  const warned = w.evaluate(withP99(10));
  assert.equal(warned.action, 'warn');
  assert.deepEqual(codes(warned), ['etcd-fsync-warn']);
});

test('fsync p99 aborts at 25 ms twice in a row, and not below', () => {
  let w = watcher();
  assert.equal(w.evaluate(withP99(24.99)).action, 'warn');
  assert.equal(w.evaluate(withP99(24.99)).action, 'warn');
  assert.equal(w.evaluate(withP99(24.99)).action, 'warn');

  w = watcher();
  assert.equal(w.evaluate(withP99(25)).action, 'warn', 'the first strike only warns');
  const second = w.evaluate(withP99(25));
  assert.equal(second.action, 'abort');
  assert.deepEqual(codes(second), ['etcd-fsync']);

  // Strikes must be consecutive.
  w = watcher();
  assert.equal(w.evaluate(withP99(30)).action, 'warn');
  assert.equal(w.evaluate(withP99(24)).action, 'warn');
  assert.equal(w.evaluate(withP99(30)).action, 'warn');
  assert.equal(w.evaluate(withP99(30)).action, 'abort');
});

test('fsync p99 aborts at once at 100 ms, not at 99.99', () => {
  assert.equal(watcher().evaluate(withP99(99.99)).action, 'warn');
  const once = watcher().evaluate(withP99(100));
  assert.equal(once.action, 'abort');
  assert.deepEqual(codes(once), ['etcd-fsync-spike']);
});

test('any leader change aborts; the first sample only sets the baseline', () => {
  const w = watcher();
  assert.equal(w.evaluate(withP99(3, 4)).action, 'ok');
  assert.equal(w.evaluate(withP99(3, 4)).action, 'ok');
  const changed = w.evaluate(withP99(3, 5));
  assert.equal(changed.action, 'abort');
  assert.deepEqual(codes(changed), ['etcd-leader-change']);
  // A source without the counter does not abort or count as blind on its own.
  const without = watcher();
  assert.equal(
    without.evaluate(sample({ etcd: { p99Ms: 3, readyz: true, leaderChanges: null } })).action,
    'ok',
  );
});

test('/readyz/etcd failing aborts', () => {
  const result = watcher().evaluate(withP99(3, 4, false));
  assert.equal(result.action, 'abort');
  assert.deepEqual(codes(result), ['etcd-readyz']);
});

test('volume: aborts at 80 % of the claim, not one byte below', () => {
  const at = (used) => watcher().evaluate(sample({ volume: { usedBytes: used } }));
  assert.equal(at(VOLUME_LIMIT - 1).action, 'ok');
  const over = at(VOLUME_LIMIT);
  assert.equal(over.action, 'abort');
  assert.deepEqual(codes(over), ['volume']);
});

test('node: any pressure condition, a node not ready, or database-node disk at 20 % free aborts', () => {
  const pressured = (kind) => {
    const s = sample();
    s.nodes[1].pressure[kind] = true;
    return watcher().evaluate(s);
  };
  for (const kind of ['memory', 'disk', 'pid']) {
    const result = pressured(kind);
    assert.equal(result.action, 'abort', kind);
    assert.deepEqual(codes(result), ['node-pressure'], kind);
  }
  const notReady = sample();
  notReady.nodes[0].ready = false;
  assert.deepEqual(codes(watcher().evaluate(notReady)), ['node-pressure']);

  const free = (fraction, index = 0) => {
    const s = sample();
    s.nodes[index].fsFreeFraction = fraction;
    return watcher().evaluate(s);
  };
  assert.equal(free(0.2001).action, 'ok');
  const low = free(0.2);
  assert.equal(low.action, 'abort');
  assert.deepEqual(codes(low), ['db-node-fs']);
  // Only the database node's free space is a stop signal.
  assert.equal(free(0.05, 1).action, 'ok');
});

test('reasons accumulate when several thresholds are crossed at once', () => {
  const s = sample({
    etcd: { p99Ms: 150, readyz: false, leaderChanges: 4 },
    volume: { usedBytes: VOLUME_LIMIT },
  });
  assert.deepEqual(codes(watcher().evaluate(s)).sort(), [
    'etcd-fsync-spike',
    'etcd-readyz',
    'volume',
  ]);
});

test('a watcher that cannot see aborts after three blind samples in a row', () => {
  const blind = () => sample({ etcd: { p99Ms: null, readyz: null, leaderChanges: null } });
  const w = watcher();
  assert.equal(w.evaluate(blind()).action, 'warn');
  assert.equal(w.evaluate(blind()).action, 'warn');
  const third = w.evaluate(blind());
  assert.equal(third.action, 'abort');
  assert.deepEqual(codes(third), ['blind']);

  // One good sample in between resets the count.
  const again = watcher();
  again.evaluate(blind());
  again.evaluate(blind());
  assert.equal(again.evaluate(sample()).action, 'ok');
  assert.equal(again.evaluate(blind()).action, 'warn');
  assert.equal(again.evaluate(blind()).action, 'warn');

  // A missing volume or database-node reading is blind too.
  const noVolume = watcher();
  for (let i = 0; i < 2; i++) noVolume.evaluate(sample({ volume: { usedBytes: null } }));
  assert.equal(noVolume.evaluate(sample({ volume: { usedBytes: null } })).action, 'abort');
  const noNode = watcher();
  for (let i = 0; i < 2; i++) noNode.evaluate(sample({ nodes: [] }));
  assert.equal(noNode.evaluate(sample({ nodes: [] })).action, 'abort');
});

test('the fire drill: a threshold forced to 0 aborts', () => {
  const drilled = (override) =>
    createWatcher({
      thresholds: { ...DEFAULT_THRESHOLDS, ...parseThresholdOverrides([override]) },
      volumeLimitBytes: VOLUME_LIMIT,
      dbNode: 'talos-cp-3',
    });
  const spike = drilled('etcdFsyncAbortOnceMs=0').evaluate(sample());
  assert.equal(spike.action, 'abort');
  assert.deepEqual(codes(spike), ['etcd-fsync-spike']);

  const strikes = drilled('etcdFsyncAbortMs=0');
  assert.equal(strikes.evaluate(sample()).action, 'warn');
  assert.equal(strikes.evaluate(sample()).action, 'abort');

  // The volume limit is derived from the claim size and the fraction.
  const viaFraction = createWatcher({
    thresholds: { ...DEFAULT_THRESHOLDS, volumeAbortFraction: 0 },
    pgSizeBytes: 150 * GIB,
    dbNode: 'talos-cp-3',
  });
  assert.equal(viaFraction.evaluate(sample()).action, 'abort');

  const disk = drilled('dbNodeFsFreeMinFraction=1').evaluate(sample());
  assert.deepEqual(codes(disk), ['db-node-fs']);
});

// --- Teardown -----------------------------------------------------------------------------

test('teardown passes only when nothing labelled remains', () => {
  assert.equal(decideTeardown({ profile: 'tiny', remaining: [] }).ok, true);
  const left = decideTeardown({ profile: 'tiny', remaining: ['pod/scale-t1-pg-1'] });
  assert.equal(left.ok, false);
  assert.match(left.problems.join(' '), /pod\/scale-t1-pg-1/);
  // Not being able to list is not a pass.
  assert.equal(decideTeardown({ profile: 'tiny', remaining: null }).ok, false);
});

test('medium and large also need the pool back at its starting allocation', () => {
  const pool = (before, after) => ({ poolBeforeBytes: before * GIB, poolAfterBytes: after * GIB });
  assert.equal(decideTeardown({ profile: 'large', remaining: [], ...pool(10, 10) }).ok, true);
  assert.equal(decideTeardown({ profile: 'large', remaining: [], ...pool(10, 9) }).ok, true);
  const grown = decideTeardown({ profile: 'large', remaining: [], ...pool(10, 11) });
  assert.equal(grown.ok, false);
  assert.match(grown.problems.join(' '), /pool/i);
  assert.equal(decideTeardown({ profile: 'medium', remaining: [], ...pool(10, 11) }).ok, false);
  assert.equal(
    decideTeardown({ profile: 'large', remaining: [], poolBeforeBytes: null, poolAfterBytes: 1 })
      .ok,
    false,
  );
  // Smaller profiles are not held to the pool check.
  assert.equal(decideTeardown({ profile: 'small', remaining: [], ...pool(10, 11) }).ok, true);
});

// --- The apiserver proxy: its limits come from the idle baseline ---------------------------
//
// With no etcd metrics endpoint to read (Talos serves them on localhost only), the signal is the
// apiserver's request latency to etcd: every operation, lists and watches included. The first
// read of the real cluster, idle, gave 133 to 465 ms for its p99 (the series below), roughly ten
// times the 50 ms warning level and past the 250 ms abort level: with fixed limits the watcher
// aborted an idle cluster. So for this source the limits are multiples of the baseline measured
// in the preflight window. They cannot see a moderate etcd slowdown (that is why `medium` and
// `large` need etcd's own WAL fsync histogram and the spec says so); they stop a clearly sick one.

// Measured on the bitop cluster at night, 18 samples, 15 s apart. Not synthetic.
const IDLE_PROXY = [
  171.8, 133.5, 156.667, 135, 167, 179.333, 133.5, 194.833, 194.833, 270, 251, 465, 362.571,
  365.143, 350, 190, 381.36, 377,
];
const proxyWatcher = (baseline) =>
  createWatcher({
    thresholds: { ...thresholdsFor('apiserver-request'), ...proxyThresholdsFromBaseline(baseline) },
    volumeLimitBytes: VOLUME_LIMIT,
    dbNode: 'talos-cp-3',
  });

test('proxy limits are multiples of the idle baseline, and never below the fixed floors', () => {
  const t = proxyThresholdsFromBaseline(IDLE_PROXY);
  assert.equal(t.etcdFsyncWarnMs, 697.5); // 1.5 x 465
  assert.equal(t.etcdFsyncAbortMs, 1395); // 3 x 465
  assert.equal(t.etcdFsyncAbortOnceMs, 3720); // 8 x 465
  assert.deepEqual(proxyThresholdsFromBaseline([5, 6, 7]), {
    etcdFsyncWarnMs: 50,
    etcdFsyncAbortMs: 250,
    etcdFsyncAbortOnceMs: 1000,
  });
  for (const bad of [[], null, undefined, [1, 'x'], [Number.NaN], [-1]])
    assert.throws(() => proxyThresholdsFromBaseline(bad), /baseline/i, String(bad));
});

test('the fixed proxy limits abort an idle cluster; the baseline limits do not', () => {
  const fixed = createWatcher({
    thresholds: thresholdsFor('apiserver-request'),
    volumeLimitBytes: VOLUME_LIMIT,
    dbNode: 'talos-cp-3',
  });
  const results = IDLE_PROXY.map((p99) => fixed.evaluate(withP99(p99)).action);
  assert.ok(results.includes('abort'), 'the placeholders contradict the measured idle series');

  const calibrated = proxyWatcher(IDLE_PROXY);
  for (const p99 of IDLE_PROXY)
    assert.notEqual(calibrated.evaluate(withP99(p99)).action, 'abort', String(p99));
});

test('with the baseline limits a sustained 3x aborts, and a single 8x aborts at once', () => {
  let w = proxyWatcher(IDLE_PROXY);
  assert.equal(w.evaluate(withP99(1394.99)).action, 'warn');
  assert.equal(w.evaluate(withP99(1394.99)).action, 'warn');

  w = proxyWatcher(IDLE_PROXY);
  assert.equal(w.evaluate(withP99(1395)).action, 'warn', 'the first strike only warns');
  assert.deepEqual(codes(w.evaluate(withP99(1395))), ['etcd-fsync']);

  assert.deepEqual(codes(proxyWatcher(IDLE_PROXY).evaluate(withP99(3720))), ['etcd-fsync-spike']);
  assert.equal(proxyWatcher(IDLE_PROXY).evaluate(withP99(3719.99)).action, 'warn');
});

test('preflight, proxy source: an idle baseline passes, a clearly sick one fails', () => {
  const opts = preflightOptions({ etcdSource: 'apiserver-request' });
  const r = goodReadings();
  r.etcd.fsyncP99Ms = IDLE_PROXY;
  const ok = decidePreflight(r, opts);
  assert.equal(ok.ok, true);
  assert.match(ok.checks.find((c) => c.id === 'etcd-fsync').detail, /baseline/i);

  r.etcd.fsyncP99Ms = [...IDLE_PROXY, PROXY_PREFLIGHT_CEILING_MS];
  assert.deepEqual(failed(decidePreflight(r, opts)), ['etcd-fsync']);
  r.etcd.fsyncP99Ms = [...IDLE_PROXY, PROXY_PREFLIGHT_CEILING_MS - 0.01];
  assert.equal(decidePreflight(r, opts).ok, true);

  // Etcd's own WAL fsync metric keeps its absolute rule, and so does an unspecified source.
  const wal = goodReadings();
  wal.etcd.fsyncP99Ms = IDLE_PROXY;
  assert.deepEqual(failed(decidePreflight(wal, preflightOptions())), ['etcd-fsync']);
  assert.deepEqual(failed(decidePreflight(wal, preflightOptions({ etcdSource: 'wal-fsync' }))), [
    'etcd-fsync',
  ]);
});
