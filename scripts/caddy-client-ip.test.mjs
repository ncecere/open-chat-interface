/**
 * The web container's Caddy, as shipped (docker/Caddyfile), in front of a
 * stand-in API that echoes the client-address headers it receives.
 *
 * Checks that the API is only ever told one client address, that a client
 * cannot choose it by sending its own headers, and that TRUSTED_PROXIES lets
 * an outer proxy's X-Forwarded-For through. Needs Docker and the caddy:2-alpine
 * image the web container is built from (pulled if missing).
 *
 *   node --test scripts/caddy-client-ip.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CADDY_IMAGE = 'caddy:2-alpine';
const caddyfile = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'Caddyfile');

/** Echoes the headers the API would use; `respond` expands the placeholders. */
const ECHO_CONFIG = `:3000 {
	respond "xff=[{header.X-Forwarded-For}] real=[{header.X-Real-IP}] cf=[{header.CF-Connecting-IP}] forwarded=[{header.Forwarded}]"
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

function validate(trustedProxies) {
  return docker(
    'run',
    '--rm',
    '-e',
    `TRUSTED_PROXIES=${trustedProxies}`,
    '-v',
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
  );
}

/**
 * A network with the stand-in API (`api`) and a client container whose
 * address can be named as a trusted proxy. Returns helpers to start the web
 * container with a given TRUSTED_PROXIES and to request through it.
 */
function fixture(t) {
  const id = randomBytes(4).toString('hex');
  const network = `oci-caddy-test-${id}`;
  const names = { api: `oci-caddy-api-${id}`, client: `oci-caddy-client-${id}` };
  const webs = [];
  t.after(() => {
    for (const name of [...webs, names.client, names.api]) quietly('rm', '-f', name);
    quietly('network', 'rm', network);
  });

  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    names.api,
    '--network',
    network,
    '--network-alias',
    'api',
    '--entrypoint',
    'sh',
    CADDY_IMAGE,
    '-c',
    `printf '%s\\n' '${ECHO_CONFIG}' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile`,
  );
  docker('run', '-d', '--name', names.client, '--network', network, CADDY_IMAGE, 'sleep', '600');
  const clientAddress = docker(
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    names.client,
  );
  assert.match(clientAddress, /^\d+\.\d+\.\d+\.\d+$/);

  async function startWeb(trustedProxies) {
    const name = `oci-caddy-web-${id}-${webs.length}`;
    webs.push(name);
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      '-e',
      'API_UPSTREAM=api:3000',
      '-e',
      `TRUSTED_PROXIES=${trustedProxies}`,
      '-v',
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      CADDY_IMAGE,
    );
    return async function request(headers = {}) {
      const args = ['exec', names.client, 'wget', '-qO-', '-T', '5'];
      for (const [key, value] of Object.entries(headers)) args.push('--header', `${key}: ${value}`);
      args.push(`http://${name}:8080/api/echo`);
      let lastError;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          return docker(...args);
        } catch (error) {
          lastError = error;
          await sleep(250);
        }
      }
      throw lastError;
    };
  }

  return { clientAddress, startWeb };
}

const spoofed = {
  'X-Forwarded-For': '203.0.113.9',
  'X-Real-IP': '198.51.100.7',
  'CF-Connecting-IP': '198.51.100.8',
  Forwarded: 'for=198.51.100.9',
};

test('the Caddyfile is valid with and without trusted proxies', () => {
  validate('');
  validate('10.0.0.0/8 192.168.1.5 2001:db8::/32');
  validate('private_ranges');
});

test('passes on exactly one client address and ignores client-sent headers', async (t) => {
  const { clientAddress, startWeb } = fixture(t);

  // Default: nothing in front is trusted, so the client is whoever connected.
  const request = await startWeb('');
  assert.equal(
    await request(spoofed),
    `xff=[${clientAddress}] real=[] cf=[] forwarded=[]`,
    'TRUSTED_PROXIES unset: the connecting address, whatever the client claims',
  );
  assert.equal(await request(), `xff=[${clientAddress}] real=[] cf=[] forwarded=[]`);
});

test('reads the client from a trusted outer proxy, right to left', async (t) => {
  const { clientAddress, startWeb } = fixture(t);
  // The client container stands in for an ingress controller.
  const request = await startWeb(`${clientAddress}/32`);

  // The ingress appended the address it saw (203.0.113.9) after whatever the
  // client sent (198.51.100.1); only the ingress's entry is believed.
  assert.equal(
    await request({ ...spoofed, 'X-Forwarded-For': '198.51.100.1, 203.0.113.9' }),
    'xff=[203.0.113.9] real=[] cf=[] forwarded=[]',
  );
  // A trusted proxy that sent no header: the proxy itself is the client.
  assert.equal(await request(), `xff=[${clientAddress}] real=[] cf=[] forwarded=[]`);
});
