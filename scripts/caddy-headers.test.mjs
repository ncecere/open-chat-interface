/**
 * The web container's Caddy, as shipped (docker/Caddyfile): the headers the
 * installable app (#400) depends on.
 *
 * An installed app opens the start page often, so the page a browser may keep
 * must never be a stale one: with no Cache-Control on a route such as
 * /auth/login (the file served is index.html, but the rule that said
 * "no-cache" matched only the literal /index.html path), a browser may
 * reuse its copy by heuristic freshness, and offline it would open a shell
 * from its cache instead of showing its own error. Also checks that the
 * policy names the manifest, and that the API's own cache header on the
 * manifest is not overwritten. Needs Docker and the caddy:2-alpine image the
 * web container is built from (pulled if missing).
 *
 *   node --test scripts/caddy-headers.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CADDY_IMAGE = 'caddy:2-alpine';
// Needs Docker. Skipped on a machine without it; CI always runs it.
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const needsDocker = { skip: !dockerAvailable && !process.env.CI && 'Docker is not available' };
const caddyfile = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'Caddyfile');

/** A stand-in API: serves the manifest as routes/manifest.ts does. */
const API_CONFIG = `:3000 {
	header Content-Type "application/manifest+json; charset=utf-8"
	header Cache-Control "public, max-age=300"
	respond "{}"
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

/** The web container in front of a stand-in API, serving a few static files. */
async function startWeb(t) {
  const id = randomBytes(4).toString('hex');
  const network = `oci-caddy-headers-${id}`;
  const names = { api: `oci-headers-api-${id}`, web: `oci-headers-web-${id}` };
  const site = mkdtempSync(join(tmpdir(), 'oci-headers-'));
  mkdirSync(join(site, 'assets'));
  mkdirSync(join(site, 'icons'));
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(site, 'artifact-frame.html'), '<!doctype html><title>frame</title>');
  writeFileSync(join(site, 'assets', 'app-abc123.js'), 'export {}');
  writeFileSync(join(site, 'icons', 'icon-192.png'), 'not really a png');
  t.after(() => {
    for (const name of [names.web, names.api]) quietly('rm', '-f', name);
    quietly('network', 'rm', network);
    rmSync(site, { recursive: true, force: true });
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
    `printf '%s\\n' '${API_CONFIG}' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile`,
  );
  docker(
    'run',
    '-d',
    '--name',
    names.web,
    '--network',
    network,
    '-p',
    '127.0.0.1::8080',
    '-e',
    'API_UPSTREAM=api:3000',
    '-v',
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    '-v',
    `${site}:/srv:ro`,
    CADDY_IMAGE,
  );
  const port = docker('port', names.web, '8080/tcp').split('\n')[0].split(':').pop();

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/index.html`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  return (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
}

test(
  'the pages are revalidated, so a browser never reopens a stale shell',
  needsDocker,
  async (t) => {
    const get = await startWeb(t);
    // Every route is the one index.html, so every one needs the header, not
    // only the literal /index.html.
    for (const path of [
      '/',
      '/auth/login',
      '/settings/customization',
      '/share/abc',
      '/index.html',
    ]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-cache', path);
    }
  },
);

test(
  'the icons and the other static files are revalidated; the hashed assets are not',
  needsDocker,
  async (t) => {
    const get = await startWeb(t);
    const icon = await get('/icons/icon-192.png');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('cache-control'), 'no-cache');
    const asset = await get('/assets/app-abc123.js');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    // The sandbox host keeps the policy and the header it had.
    const frame = await get('/artifact-frame.html');
    assert.equal(frame.headers.get('cache-control'), 'no-cache');
    assert.match(frame.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts;/);
  },
);

test(
  'the manifest comes through as the API sent it, under a policy that names it',
  needsDocker,
  async (t) => {
    const get = await startWeb(t);
    const manifest = await get('/api/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    assert.equal(manifest.headers.get('cache-control'), 'public, max-age=300');

    const page = await get('/auth/login');
    const policy = page.headers.get('content-security-policy') ?? '';
    assert.match(policy, /(^|; )manifest-src 'self'(;|$)/);
    assert.match(policy, /(^|; )worker-src 'self' blob:(;|$)/);
  },
);
