// What cluster.sh changes in the environment after `dev-env up`: the harness's PostgreSQL settings
// (tools/scale/compose.yaml), resource requests and limits (the spec's starting values), the API's
// harness environment and the node pinning of the load side.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuantity } from '../tools/scale/lib/cluster-guard.mjs';
import {
  apiEnvironment,
  nodeSelectorPatch,
  pgPatch,
  RESOURCES,
  resourceFlags,
  retentionWindows,
  webEnvironment,
} from '../tools/scale/lib/cluster-settings.mjs';

const GIB = 1024 ** 3;

test("the harness PostgreSQL settings are the compose file's", () => {
  const { spec } = pgPatch(150 * GIB);
  assert.deepEqual(spec.postgresql.parameters, {
    'pg_stat_statements.track': 'top',
    'pg_stat_statements.max': '10000',
    track_io_timing: 'on',
    max_connections: '400',
    shared_buffers: '1GB',
    effective_cache_size: '3GB',
    work_mem: '16MB',
    maintenance_work_mem: '512MB',
    max_wal_size: '8GB',
    checkpoint_timeout: '15min',
    wal_compression: 'on',
    random_page_cost: '1.1',
    max_parallel_maintenance_workers: '2',
  });
});

test('every parameter value is a string, as CloudNativePG requires', () => {
  for (const size of [5, 15, 40, 150]) {
    for (const [key, value] of Object.entries(pgPatch(size * GIB).spec.postgresql.parameters)) {
      assert.equal(typeof value, 'string', key);
    }
  }
});

test('max_wal_size never exceeds a quarter of the volume, so WAL cannot fill a small claim', () => {
  const walMb = (size) => {
    const value = pgPatch(size * GIB).spec.postgresql.parameters.max_wal_size;
    return value.endsWith('GB') ? Number.parseInt(value, 10) * 1024 : Number.parseInt(value, 10);
  };
  assert.equal(walMb(5), 1280);
  assert.equal(walMb(15), 3840);
  assert.equal(walMb(40), 8192);
  assert.equal(walMb(150), 8192);
});

test("Postgres resources are the spec's starting values", () => {
  assert.deepEqual(pgPatch(5 * GIB).spec.resources, {
    requests: { cpu: '2', memory: '6Gi' },
    limits: { cpu: '4', memory: '8Gi' },
  });
});

test('the patch changes nothing but parameters and resources', () => {
  assert.deepEqual(Object.keys(pgPatch(5 * GIB)), ['spec']);
  assert.deepEqual(Object.keys(pgPatch(5 * GIB).spec).sort(), ['postgresql', 'resources']);
  assert.deepEqual(Object.keys(pgPatch(5 * GIB).spec.postgresql), ['parameters']);
});

test("API and worker resources are the spec's starting values, as kubectl flags", () => {
  assert.deepEqual(RESOURCES.api, {
    requests: { cpu: '1', memory: '1Gi' },
    limits: { cpu: '2', memory: '2Gi' },
  });
  assert.deepEqual(resourceFlags('api'), [
    '--requests=cpu=1,memory=1Gi',
    '--limits=cpu=2,memory=2Gi',
  ]);
  assert.throws(() => resourceFlags('nonsense'), /resources/i);
});

test('the memory limits fit the node-sized limits the spec names', () => {
  assert.equal(parseQuantity(RESOURCES.postgres.limits.memory), 8 * GIB);
  assert.ok(
    parseQuantity(RESOURCES.postgres.requests.memory) <=
      parseQuantity(RESOURCES.postgres.limits.memory),
  );
});

test('the API gets the harness limits and the metrics token from a Secret, never a literal', () => {
  const env = apiEnvironment('scale-t1');
  assert.deepEqual(env.literals, {
    RATE_LIMIT_AUTH_PER_MINUTE: '1000000',
    RATE_LIMIT_CHAT_PER_MINUTE: '100000',
    RATE_LIMIT_MAX_CONCURRENT_STREAMS: '100',
    RATE_LIMIT_UPLOAD_PER_MINUTE: '100000',
    LOG_LEVEL: 'warn',
  });
  assert.deepEqual(env.fromSecret, { name: 'scale-t1-scale-harness', keys: ['METRICS_TOKEN'] });
  assert.ok(!JSON.stringify(env).includes('token-value'));
});

test("the web proxy trusts the private ranges, so each person's X-Forwarded-For counts", () => {
  assert.deepEqual(webEnvironment(), { TRUSTED_PROXIES: 'private_ranges' });
});

test('retention windows are the oldest quarter, as the generator suggests', () => {
  assert.deepEqual(retentionWindows({ usageDays: 360, auditDays: 364 }), {
    usageEvents: 270,
    auditLog: 273,
  });
  assert.deepEqual(retentionWindows({ usageDays: 0.5, auditDays: 0 }), {
    usageEvents: 1,
    auditLog: 1,
  });
  assert.deepEqual(retentionWindows({ usageDays: null, auditDays: null }), {
    usageEvents: 67,
    auditLog: 273,
  });
});

test('the load side is pinned by hostname', () => {
  assert.deepEqual(nodeSelectorPatch('talos-cp-1'), {
    spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'talos-cp-1' } } } },
  });
  for (const bad of ['', 'Talos', 'a b', 'x;y', undefined]) {
    assert.throws(() => nodeSelectorPatch(bad), /node/i, String(bad));
  }
});
