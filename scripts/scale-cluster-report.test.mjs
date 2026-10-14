// The report changes for runs on the cluster (tools/scale/lib/report-db.mjs and report-render.mjs):
// the API host and port are configurable, availability keeps the status label, a cluster report
// carries an `environment` block instead of the laptop sentence, and a laptop report is unchanged.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeCluster } from '../tools/scale/lib/cluster-environment.mjs';
import { apiTarget, requestOutcomes, scrapeReplicas } from '../tools/scale/lib/report-db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'tools/scale/report.mjs');
const GIB = 1024 ** 3;

const METRICS = [
  '# TYPE oci_http_requests_total counter',
  'oci_http_requests_total{method="GET",route="/api/threads",status="200"} 900',
  'oci_http_requests_total{method="GET",route="/api/threads",status="404"} 10',
  'oci_http_requests_total{method="POST",route="/api/chat",status="500"} 3',
  'oci_http_requests_total{method="POST",route="/api/chat",status="503"} 2',
  'oci_http_requests_total{method="GET",route="/api/health/ready",status="200"} 5000',
  'oci_http_requests_total{method="GET",route="/api/health/ready",status="503"} 40',
  'oci_http_requests_total{method="GET",route="unmatched",status="404"} 7',
  'oci_http_requests_total{method="GET",route="/metrics",status="200"} 30',
  '',
].join('\n');

const sandboxes = [];
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oci-scale-report-'));
  sandboxes.push(dir);
  return dir;
};
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

test('the API host and port come from SCALE_API_HOST and SCALE_API_PORT, defaulting to the compose names', () => {
  assert.deepEqual(apiTarget({}), { host: 'api', port: 3000 });
  assert.deepEqual(apiTarget({ SCALE_API_HOST: 'scale-t1-open-chat-interface-api-headless' }), {
    host: 'scale-t1-open-chat-interface-api-headless',
    port: 3000,
  });
  assert.deepEqual(apiTarget({ SCALE_API_HOST: 'x', SCALE_API_PORT: '3100' }), {
    host: 'x',
    port: 3100,
  });
  assert.throws(() => apiTarget({ SCALE_API_PORT: 'abc' }), /SCALE_API_PORT/);
});

test('availability counts requests by status, without probes, /metrics or unmatched routes', () => {
  const series = METRICS.split('\n')
    .map((line) => /^oci_http_requests_total\{([^}]*)\}\s+(\d+)/.exec(line))
    .filter(Boolean)
    .map((m) => ({
      name: 'oci_http_requests_total',
      labels: Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((p) => [p[1], p[2]])),
      value: Number(m[2]),
    }));
  assert.deepEqual(requestOutcomes(series), {
    counted: 915,
    serverErrors: 5,
    byClass: { '2xx': 900, '4xx': 10, '5xx': 5 },
  });
  assert.deepEqual(requestOutcomes([]), { counted: 0, serverErrors: 0, byClass: {} });
});

test('scrapeReplicas reads every address of SCALE_API_HOST on SCALE_API_PORT with the bearer token', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    res.end(METRICS);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keys = ['SCALE_API_HOST', 'SCALE_API_PORT', 'SCALE_METRICS_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.SCALE_API_HOST = '127.0.0.1';
  process.env.SCALE_API_PORT = String(server.address().port);
  process.env.SCALE_METRICS_TOKEN = 'test-token';
  try {
    const metrics = await scrapeReplicas();
    assert.equal(metrics.replicas, 1);
    assert.deepEqual(metrics.requestsPerReplica, [5992]);
    assert.deepEqual(metrics.requests, {
      counted: 915,
      serverErrors: 5,
      byClass: { '2xx': 900, '4xx': 10, '5xx': 5 },
    });
    assert.deepEqual(seen, [['/metrics', 'Bearer test-token']]);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    server.close();
  }
});

function renderReport(dir, extraEnv) {
  const result = spawnSync(process.execPath, [REPORT, 'render', '--run-dir', dir], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SCALE_PROFILE: 'tiny',
      SCALE_DATE: '2026-10-14',
      SCALE_COMMIT: 'abc1234',
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    json: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')),
    markdown: readFileSync(join(dir, 'report.md'), 'utf8'),
  };
}

const dbMain = {
  phase: 'main',
  databaseBytes: GIB,
  tables: [],
  indexes: [],
  named: null,
  statements: null,
  jobs: [],
  backlog: {},
  vectorProbe: null,
  metrics: {
    replicas: 2,
    requestsPerReplica: [500, 415],
    requests: { counted: 915, serverErrors: 5, byClass: { '2xx': 900, '4xx': 10, '5xx': 5 } },
    replies: 0,
    jobs: {},
    routes: [],
  },
};

function clusterRun() {
  const dir = sandbox();
  const environmentFile = join(dir, 'environment.json');
  const node = (name) => ({
    name,
    cpuCores: 8,
    memoryBytes: 32 * GIB,
    kernel: '6.12.43-talos',
    os: 'Talos (v1.11.0)',
    arch: 'amd64',
  });
  writeFileSync(
    environmentFile,
    JSON.stringify(
      describeCluster({
        nodes: [node('talos-cp-1'), node('talos-cp-3')],
        dbNode: 'talos-cp-3',
        loadNode: 'talos-cp-1',
        pgSize: '40Gi',
        apiReplicas: 2,
        k6Image: 'grafana/k6:1.3.0',
        commit: 'abc1234',
      }),
    ),
  );
  const results = join(dir, 'results');
  mkdirSync(results);
  writeFileSync(join(results, 'db-main.json'), JSON.stringify(dbMain));
  writeFileSync(
    join(results, 'pg_version.txt'),
    'PostgreSQL 18.6 (Debian 18.6-1) on x86_64-pc-linux-gnu\n',
  );
  writeFileSync(
    join(results, 'pg_extensions.txt'),
    'plpgsql 1.0\npg_stat_statements 1.12\nvector 0.8.7\n',
  );
  writeFileSync(
    join(results, 'pg_settings.tsv'),
    'max_connections\t400\t\tconfiguration file\nshared_buffers\t131072\t8kB\tconfiguration file\n',
  );
  writeFileSync(join(results, 'background-before.tsv'), 'a\tpending\t0\t10\n');
  writeFileSync(join(results, 'background-after.tsv'), 'a\tfinished\t10\t10\n');
  return { results, environmentFile };
}

test("a cluster report carries the environment block, labelled as the spec's table", () => {
  const { results, environmentFile } = clusterRun();
  const { json, markdown } = renderReport(results, {
    SCALE_ENVIRONMENT_FILE: environmentFile,
    SCALE_API_REPLICAS: '2',
  });
  assert.equal(json.environment.kind, 'cluster');
  for (const key of [
    'hardware',
    'sharing',
    'postgres',
    'topology',
    'storage',
    'loadGenerator',
    'backgroundState',
  ]) {
    assert.equal(typeof json.environment[key], 'string', key);
  }
  assert.match(json.environment.postgres, /^PostgreSQL 18\.6 with pgvector 0\.8\.7/);
  assert.match(
    json.environment.backgroundState,
    /At the start of the load: 1 pending \(a\)\. At the end: 1 finished/,
  );
  for (const label of [
    'Hardware',
    'Sharing',
    'PostgreSQL',
    'Topology',
    'Storage',
    'Load generator',
    'Background state',
  ]) {
    assert.match(markdown, new RegExp(`^\\| ${label} \\| .+ \\|$`, 'm'), label);
  }
  assert.match(markdown, /not production's PostgreSQL 17/);
  assert.match(markdown, /talos-cp-3 \(database\): 8 CPUs, 32 GiB memory/);
});

test('a cluster report does not say Docker or that everything shares one machine', () => {
  const { results, environmentFile } = clusterRun();
  const { markdown } = renderReport(results, { SCALE_ENVIRONMENT_FILE: environmentFile });
  assert.doesNotMatch(markdown, /Docker/);
  assert.doesNotMatch(markdown, /shares that machine/);
  assert.doesNotMatch(markdown, /Hardware: unknown CPU/);
});

test('availability is reported from the status label: 5xx of the counted requests', () => {
  const { results, environmentFile } = clusterRun();
  const { json, markdown } = renderReport(results, { SCALE_ENVIRONMENT_FILE: environmentFile });
  assert.deepEqual(json.replicaMetrics.requests, dbMain.metrics.requests);
  assert.match(
    markdown,
    /Availability: 99\.45 % of 915 counted requests were not answered with a 5xx \(5 were\)/,
  );
});

test('a laptop report is unchanged: no environment block, the Docker sentence stays', () => {
  const dir = sandbox();
  const { json, markdown } = renderReport(dir, {
    SCALE_HW_CPU: 'Apple M4 Pro',
    SCALE_HW_MEMORY: '48 GiB',
    SCALE_DOCKER_CPUS: '12',
    SCALE_DOCKER_MEMORY: '7 GiB',
  });
  assert.equal(json.environment, null);
  assert.match(
    markdown,
    /Hardware: Apple M4 Pro, 48 GiB memory; Docker: 12 CPUs, 7 GiB memory\. Everything \(PostgreSQL, Redis, API, web, stub, k6\) shares that machine\./,
  );
  assert.doesNotMatch(markdown, /## Environment/);
});

test('a cluster report whose files were not recorded says so', () => {
  const { environmentFile } = clusterRun();
  const dir = sandbox();
  const { json, markdown } = renderReport(dir, { SCALE_ENVIRONMENT_FILE: environmentFile });
  assert.match(json.environment.postgres, /version not recorded/);
  assert.match(markdown, /Background state \| .*not recorded/);
});

test('a missing environment file is an error, not a silent laptop report', () => {
  const dir = sandbox();
  const result = spawnSync(process.execPath, [REPORT, 'render', '--run-dir', dir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SCALE_ENVIRONMENT_FILE: join(dir, 'nope.json') },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCALE_ENVIRONMENT_FILE/);
});
