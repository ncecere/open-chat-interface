// Docker Compose, psql through HAProxy, Patroni state, waiting and image builds.

import { run, sleep } from '../../upgrade-test/lib.mjs';
import {
  COMPOSE_FILE,
  env,
  log,
  PATRONI_CONFIG,
  PROJECT,
  REPO_ROOT,
  SUPERUSER_URL,
} from './context.mjs';

/* ------------------------------------------------------------------------ */

export function compose(args, options = {}) {
  const profiles = options.redis === false ? [] : ['--profile', 'redis-ha'];
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...profiles, ...args], {
    env: { ...env, ...options.env },
    ...options,
  });
}

export async function must(promise, what) {
  const result = await promise;
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result;
}

/** SQL through HAProxy, so it always reaches the current primary. */
export async function psql(sql, { database = 'oci', node = 'pg-1' } = {}) {
  const result = await must(
    compose(
      [
        'exec',
        '-T',
        node,
        'psql',
        `${SUPERUSER_URL}/${database}`,
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-F',
        '\t',
      ],
      { input: sql },
    ),
    'psql',
  );
  return result.stdout.trim();
}

export async function cluster() {
  for (const node of ['pg-1', 'pg-2', 'pg-3']) {
    const result = await compose([
      'exec',
      '-T',
      node,
      'patronictl',
      '-c',
      PATRONI_CONFIG,
      'list',
      '-f',
      'json',
    ]);
    if (result.code === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch {}
    }
  }
  return [];
}

export async function waitFor(what, check, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

export async function buildImage(app) {
  const image = `oci-failover-${app}:drill`;
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from this checkout (${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run(
      'docker',
      [
        'build',
        '-q',
        '-f',
        `docker/${app}.Dockerfile`,
        '--build-arg',
        `OCI_REVISION=${revision}`,
        '-t',
        image,
        '.',
      ],
      {
        cwd: REPO_ROOT,
      },
    ),
    `building ${image}`,
  );
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return image;
}
