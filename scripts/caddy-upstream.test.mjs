/**
 * The web container's Caddy, as shipped (docker/Caddyfile), with the API
 * unreachable and with API replicas failing.
 *
 * Checks that an unreachable API does not flood the web log (#289: a failed
 * lookup of the API name was logged on every retry, about 47 lines a
 * request), and that the retry settings still fail over: a request whose
 * replica has died goes to another, a single replica marked down by a
 * refused chat turn is tried again within lb_try_duration (#117), a resent
 * turn goes to a replica that is not draining, and the turns a draining
 * replica refuses do not hold up anything else (#306). Needs Docker and the
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

/** A stand-in API replica: names itself. */
const API_CONFIG = `:3000 {
	respond "replica={system.hostname}"
}`;

/**
 * A draining one (apps/api/src/lib/drain.ts): refuses new chat turns with
 * 503, Retry-After and X-OCI-Draining, and answers everything else.
 */
const DRAINING_API_CONFIG = `:3000 {
	@turn {
		method POST
		path_regexp ^/api/chat(/[^/]+/approvals)?/?$
	}
	header @turn Retry-After 1
	header @turn X-OCI-Draining 1
	respond @turn 503
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

  function startReplica({ draining = false } = {}) {
    const config = draining ? DRAINING_API_CONFIG : API_CONFIG;
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
      `printf '%s\\n' '${config}' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile`,
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

  /** Status, body, Retry-After and seconds taken for a request through the web container. */
  async function request(path, init) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, init);
    const body = await response.text();
    return {
      status: response.status,
      body,
      retryAfter: response.headers.get('retry-after'),
      seconds: (performance.now() - started) / 1000,
    };
  }

  /**
   * A chat turn sent as the web app sends it (apps/web/src/lib/chat-retry.ts):
   * a refusal with Retry-After is sent again after it, up to twice. Every
   * attempt's answer, in order.
   */
  async function sendTurn() {
    const send = () => request('/api/chat', { method: 'POST', body: '{}' });
    const attempts = [await send()];
    for (let retry = 0; retry < 2; retry++) {
      const last = attempts.at(-1);
      if (last.status !== 503 || last.retryAfter === null) break;
      await sleep(Number(last.retryAfter) * 1000);
      attempts.push(await send());
    }
    return attempts;
  }

  /** Waits until the web container reaches the API replicas. */
  async function untilServed() {
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await request('/api/anything')).status === 200) return;
      await sleep(100);
    }
    throw new Error('the API was not reached');
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

  return { startReplica, startWeb, request, sendTurn, untilServed, logSince };
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
  'a single replica marked down by a refused turn is tried again within lb_try_duration (#117)',
  needsDocker,
  async (t) => {
    const { startReplica, startWeb, request, untilServed } = fixture(t);
    const only = startReplica({ draining: true });
    await startWeb();
    await untilServed();

    // A draining replica refuses a new turn: marked down for turns for fail_duration (3 s).
    const refused = await request('/api/chat', { method: 'POST', body: '{}' });
    assert.equal(refused.status, 503);
    assert.equal(refused.retryAfter, '1');
    // With nowhere else to go, the next turn waits out the mark and reaches
    // the replica (its own refusal, with Retry-After), not "no upstreams".
    const next = await request('/api/chat', { method: 'POST', body: '{}' });
    assert.equal(next.status, 503);
    assert.equal(next.retryAfter, '1', 'answered by the replica, not by the proxy');
    assert.ok(
      next.seconds >= 2 && next.seconds < 4.5,
      `answered after ${next.seconds.toFixed(1)} s`,
    );
    // Anything else is served at once by the draining replica.
    const { status, body, seconds } = await request('/api/anything');
    assert.equal(status, 200, body);
    assert.equal(body, `replica=${only}`);
    assert.ok(seconds < 1, `served after ${seconds.toFixed(1)} s`);
  },
);

test(
  'turns a single draining replica refuses do not hold up other requests (#306)',
  needsDocker,
  async (t) => {
    const { startReplica, startWeb, request, sendTurn, untilServed } = fixture(t);
    const only = startReplica({ draining: true });
    await startWeb();
    await untilServed();

    // Several tabs send a message during a graceful restart, a little apart,
    // and the web app sends each again when it is refused. Each refusal
    // marked the replica down again; the resends queued in the proxy reached
    // it as each mark ran out and marked it once more, so a request waiting
    // meanwhile waited the whole lb_try_duration and failed with "no
    // upstreams available" (seen 1 in 2 runs with one tab).
    const turns = [0, 700, 1500, 2300, 3100].map(async (delay) => {
      await sleep(delay);
      return sendTurn();
    });
    const reads = [];
    for (let i = 0; i < 16; i++) {
      reads.push(request('/api/threads?limit=1'));
      await sleep(500);
    }
    for (const attempts of await Promise.all(turns)) {
      for (const attempt of attempts) assert.equal(attempt.status, 503);
    }
    for (const { status, body, seconds } of await Promise.all(reads)) {
      assert.equal(status, 200, body);
      assert.equal(body, `replica=${only}`);
      // Not held up by the marks at all: before, up to 5 s and then 503.
      assert.ok(seconds < 1, `served after ${seconds.toFixed(1)} s`);
    }
  },
);

test(
  'a refused turn is sent again to a replica that is not draining (#117)',
  needsDocker,
  async (t) => {
    const { startReplica, startWeb, request, sendTurn } = fixture(t);
    startReplica({ draining: true });
    const ready = startReplica();
    await startWeb();

    // Both replicas in rotation (the name is resolved again every 2 s).
    const seen = new Set();
    for (let attempt = 0; attempt < 40 && seen.size < 2; attempt++) {
      const { status, body } = await request('/api/anything');
      if (status === 200) seen.add(body);
      await sleep(100);
    }
    assert.equal(seen.size, 2);

    for (let turn = 0; turn < 4; turn++) {
      const attempts = await sendTurn();
      const last = attempts.at(-1);
      // Refused at most once: the resend avoids the replica marked down.
      assert.ok(attempts.length <= 2, attempts.map((a) => a.status).join(', '));
      assert.equal(last.status, 200, last.body);
      assert.equal(last.body, `replica=${ready}`);
    }
  },
);
