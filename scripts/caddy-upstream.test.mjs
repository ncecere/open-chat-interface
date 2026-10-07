/**
 * The web container's Caddy, as shipped (docker/Caddyfile), with the API
 * unreachable and with API replicas failing.
 *
 * Checks that an unreachable API does not flood the web log (#289: a failed
 * lookup of the API name was logged on every retry, about 47 lines a
 * request), and that the retry settings still fail over: a request whose
 * replica has died goes to another, and a single replica marked down by a
 * 503 is tried again within lb_try_duration (#117). Needs Docker and the
 * caddy:2-alpine image the web container is built from (pulled if missing).
 *
 *   node --test scripts/caddy-upstream.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CADDY_IMAGE = 'caddy:2-alpine';
// Needs Docker. Skipped on a machine without it; CI always runs it.
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const needsDocker = { skip: !dockerAvailable && !process.env.CI && 'Docker is not available' };
const caddyfile = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'Caddyfile');

/** A stand-in API replica: names itself, and answers 503 as a draining one would. */
const API_CONFIG = `:3000 {
	respond /api/draining 503
	respond "replica={system.hostname}"
}`;

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function quietly(...args) {
  try {
    docker(...args);
  } catch {
    // Already gone.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A network for one test, the web container on it, and helpers. */
function fixture(t) {
  const id = randomBytes(4).toString('hex');
  const network = `oci-caddy-upstream-${id}`;
  const web = `oci-caddy-upstream-web-${id}`;
  const replicas = [];
  t.after(() => {
    for (const name of [web, ...replicas]) quietly('rm', '-f', name);
    quietly('network', 'rm', network);
  });
  docker('network', 'create', network);

  function startReplica() {
    const name = `oci-caddy-upstream-api-${id}-${replicas.length}`;
    replicas.push(name);
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--hostname',
      name,
      '--network',
      network,
      '--network-alias',
      'api',
      '--entrypoint',
      'sh',
      CADDY_IMAGE,
      '-c',
      `printf '%s\\n' '${API_CONFIG}' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile`,
    );
    return name;
  }

  let base;
  async function startWeb() {
    docker(
      'run',
      '-d',
      '--name',
      web,
      '--network',
      network,
      '-p',
      '127.0.0.1::8080',
      '-e',
      'API_UPSTREAM=api:3000',
      '-v',
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      CADDY_IMAGE,
    );
    base = `http://${docker('port', web, '8080/tcp').split('\n')[0]}`;
    // Until Caddy listens (the app's index is not there: any answer will do).
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await fetch(`${base}/`);
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error('the web container did not start');
  }

  /** Status, body and seconds taken for a request through the web container. */
  async function request(path) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    return { status: response.status, body, seconds: (performance.now() - started) / 1000 };
  }

  /** The web container's log lines; Caddy writes them to stderr. */
  function webLog() {
    const { stderr } = spawnSync('docker', ['logs', web], { encoding: 'utf8' });
    return stderr.split('\n').filter(Boolean);
  }

  /** Returns a function that gives the log lines written after this call. */
  function logSince() {
    const before = webLog().length;
    return () => webLog().slice(before);
  }

  return { startReplica, startWeb, request, logSince };
}

test(
  'an unreachable API logs one line per failed request, not one per retry (#289)',
  needsDocker,
  async (t) => {
    const { startWeb, request, logSince } = fixture(t);
    // No replica at all: the name `api` does not resolve, as with the API stopped.
    await startWeb();
    const since = logSince();

    for (let i = 0; i < 3; i++) {
      const { status, seconds } = await request('/api/health/live');
      assert.equal(status, 502);
      // The proxy still keeps trying for lb_try_duration before giving up.
      assert.ok(seconds >= 4.5, `gave up after ${seconds.toFixed(1)} s`);
    }
    await sleep(500);

    const lines = since();
    const perRequest = lines.filter((line) => line.includes('"logger":"http.log.error"'));
    const lookups = lines.filter((line) => line.includes('failed getting dynamic upstreams'));
    // Each failed request is still logged, so the outage stays visible...
    assert.equal(perRequest.length, 3, lines.join('\n'));
    // ...but the failed lookup behind it once per 10 s, not on every retry
    // (it was 141 lines for these three requests). 15 s spans at most 3 periods.
    assert.ok(lookups.length >= 1 && lookups.length <= 3, `${lookups.length} lookup lines`);
    assert.ok(lines.length <= 6, `${lines.length} lines:\n${lines.join('\n')}`);
  },
);

test('a request whose replica died goes to another replica', needsDocker, async (t) => {
  const { startReplica, startWeb, request } = fixture(t);
  const first = startReplica();
  const second = startReplica();
  await startWeb();

  // Both replicas in rotation (the name is resolved again every 2 s).
  const seen = new Set();
  for (let attempt = 0; attempt < 40 && seen.size < 2; attempt++) {
    const { status, body } = await request('/api/anything');
    if (status === 200) seen.add(body);
    await sleep(100);
  }
  assert.deepEqual([...seen].sort(), [`replica=${first}`, `replica=${second}`].sort());

  // Killed, not drained: Caddy still has its address until the next lookup.
  docker('kill', first);
  for (let i = 0; i < 10; i++) {
    const { status, body, seconds } = await request('/api/anything');
    assert.equal(status, 200, body);
    assert.equal(body, `replica=${second}`);
    assert.ok(seconds < 2.5, `request ${i} took ${seconds.toFixed(1)} s`);
  }
});

test(
  'a single replica marked down by a 503 is tried again within lb_try_duration (#117)',
  needsDocker,
  async (t) => {
    const { startReplica, startWeb, request } = fixture(t);
    const only = startReplica();
    await startWeb();
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await request('/api/anything')).status === 200) break;
      await sleep(100);
    }

    // A draining replica refuses a new turn: marked down for fail_duration (3 s).
    assert.equal((await request('/api/draining')).status, 503);
    // With nowhere else to go, the next request waits out the mark and is served.
    const { status, body, seconds } = await request('/api/anything');
    assert.equal(status, 200, body);
    assert.equal(body, `replica=${only}`);
    assert.ok(seconds >= 2 && seconds < 4.5, `served after ${seconds.toFixed(1)} s`);
  },
);
