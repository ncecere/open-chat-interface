// The `environment` block of a cluster report: the labels of docs/dev/scale-harness.md, "Large on
// the cluster" (hardware, sharing, PostgreSQL, topology, storage, load generator, background state).
// cluster.sh describes the nodes when it starts (describeCluster); the render step completes it
// from the server's own answers (completeEnvironment).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeEnvironment,
  describeCluster,
  ENVIRONMENT_LABELS,
  summariseBackground,
} from '../tools/scale/lib/cluster-environment.mjs';

const GIB = 1024 ** 3;
const node = (name, extra = {}) => ({
  name,
  ready: true,
  pressure: { memory: false, disk: false, pid: false },
  cpuCores: 8,
  memoryBytes: 32 * GIB,
  kernel: '6.12.43-talos',
  os: 'Talos (v1.11.0)',
  arch: 'amd64',
  kubelet: 'v1.34.0',
  ...extra,
});

const described = () =>
  describeCluster({
    nodes: [node('talos-cp-1'), node('talos-cp-2', { cpuCores: 4 }), node('talos-cp-3')],
    dbNode: 'talos-cp-3',
    loadNode: 'talos-cp-1',
    pgSize: '150Gi',
    apiReplicas: 2,
    k6Image: 'grafana/k6:1.3.0',
    commit: 'abc1234',
  });

test("the labels are the spec's table, in its order", () => {
  assert.deepEqual(ENVIRONMENT_LABELS, {
    hardware: 'Hardware',
    sharing: 'Sharing',
    postgres: 'PostgreSQL',
    topology: 'Topology',
    storage: 'Storage',
    loadGenerator: 'Load generator',
    backgroundState: 'Background state',
  });
});

test('describeCluster names the database and load nodes and what runs where', () => {
  const env = described();
  assert.equal(env.kind, 'cluster');
  assert.match(
    env.hardware,
    /talos-cp-3 \(database\): 8 CPUs, 32 GiB memory, Talos \(v1\.11\.0\), kernel 6\.12\.43-talos/,
  );
  assert.match(env.hardware, /talos-cp-1 \(load\): 8 CPUs/);
  assert.doesNotMatch(env.hardware, /talos-cp-2/);
  assert.match(env.sharing, /Production services and other development environments/);
  assert.match(env.topology, /database on talos-cp-3/i);
  assert.match(
    env.topology,
    /2 API replicas \(role web\), 1 worker, web proxy, stub model and k6 on talos-cp-1/,
  );
  assert.match(env.storage, /Miroir ext4/);
  assert.match(env.storage, /150Gi/);
  assert.match(env.loadGenerator, /k6 pod \(grafana\/k6:1\.3\.0\) on talos-cp-1/);
});

test('describeCluster fails on a node it cannot find, never invents hardware', () => {
  assert.throws(
    () =>
      describeCluster({
        nodes: [node('talos-cp-1')],
        dbNode: 'talos-cp-3',
        loadNode: 'talos-cp-1',
        pgSize: '5Gi',
        apiReplicas: 1,
        k6Image: 'k',
        commit: 'c',
      }),
    /talos-cp-3/,
  );
});

const SETTINGS = [
  'max_connections\t400\t\tconfiguration file',
  'shared_buffers\t131072\t8kB\tconfiguration file',
  'work_mem\t16384\tkB\tconfiguration file',
  'random_page_cost\t1.1\t\tconfiguration file',
  'unrelated_setting\t1\t\tdefault',
  '',
].join('\n');

test('completeEnvironment adds the server version, extensions, settings and background state', () => {
  const env = completeEnvironment(described(), {
    pgVersion:
      'PostgreSQL 18.6 (Debian 18.6-1.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc, 64-bit\n',
    extensions: 'pg_stat_statements 1.12\nplpgsql 1.0\nvector 0.8.7\n',
    settings: SETTINGS,
    backgroundBefore:
      '0.13.message-search-folded\trunning\t120000\t20000000\n0.12.x\tfinished\t5\t5\n',
    backgroundAfter:
      '0.13.message-search-folded\tfinished\t20000000\t20000000\n0.12.x\tfinished\t5\t5\n',
  });
  assert.match(env.postgres, /^PostgreSQL 18\.6 with pgvector 0\.8\.7/);
  assert.match(env.postgres, /not production's PostgreSQL 17/);
  assert.match(env.postgres, /max_connections 400/);
  assert.match(env.postgres, /shared_buffers 131072 8kB/);
  assert.doesNotMatch(env.postgres, /unrelated_setting/);
  assert.match(
    env.backgroundState,
    /At the start of the load: 1 finished, 1 running \(0\.13\.message-search-folded\)/,
  );
  assert.match(env.backgroundState, /At the end: 2 finished/);
  assert.equal(env.kind, 'cluster');
  assert.equal(env.hardware, described().hardware);
});

test('what was not recorded is said so, not left blank or guessed', () => {
  const env = completeEnvironment(described(), {});
  assert.match(env.postgres, /version not recorded/i);
  assert.match(env.postgres, /PostgreSQL 17/);
  assert.match(env.backgroundState, /not recorded/i);
});

test('summariseBackground counts by status and names what is not finished', () => {
  assert.equal(summariseBackground(''), 'none listed');
  assert.equal(summariseBackground(undefined), 'not recorded');
  assert.equal(
    summariseBackground('a\tfinished\t1\t1\nb\tpending\t0\t9\nc\tpending\t0\t9\nd\tfailed\t0\t1\n'),
    '1 finished, 2 pending (b, c), 1 failed (d)',
  );
});
