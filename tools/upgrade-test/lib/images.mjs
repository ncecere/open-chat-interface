// FROM/TO images: published release lookup, pulling, building from source, journals.

import { must, PROJECT, run } from '../lib.mjs';
import { log, options, REGISTRY, STABLE } from './context.mjs';

/* ------------------------------------------------------------------------ */

export function compareVersions(a, b) {
  const x = a.match(STABLE).slice(1).map(Number);
  const y = b.match(STABLE).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function publishedTags(app) {
  const repo = `${REGISTRY.replace('ghcr.io/', '')}/${app}`;
  const token = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`, {
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());
  const response = await fetch(`https://ghcr.io/v2/${repo}/tags/list?n=1000`, {
    headers: { authorization: `Bearer ${token.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GHCR tag list for ${app}: HTTP ${response.status}`);
  return (await response.json()).tags ?? [];
}

export async function resolveFrom(sourceVersion) {
  if (options.from) return options.from.startsWith('v') ? options.from : `v${options.from}`;
  let tags;
  try {
    const [api, web] = await Promise.all([publishedTags('api'), publishedTags('web')]);
    tags = api.filter((t) => web.includes(t));
  } catch (error) {
    log(`could not list GHCR tags (${error.message}); falling back to git tags`);
    tags = (await run('git', ['tag', '-l', 'v*'])).stdout.split('\n');
  }
  const older = tags
    .filter((t) => STABLE.test(t) && compareVersions(t, `v${sourceVersion}`) < 0)
    .sort(compareVersions);
  if (!older.length) throw new Error(`No published stable release older than ${sourceVersion}`);
  return older.at(-1);
}

/** The Docker server's architecture (`amd64`, `arm64`): images of it run natively. */
let hostArchPromise;
export function hostArch() {
  hostArchPromise ??= run('docker', ['version', '--format', '{{.Server.Arch}}']).then(
    (r) => r.stdout.trim() || 'amd64',
  );
  return hostArchPromise;
}

export async function localArch(image) {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Architecture}}', image]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Makes `image` available, natively when the registry has the host's
 * architecture. Releases from v0.11 are multi-arch (linux/amd64 and
 * linux/arm64); earlier ones are linux/amd64 only and run emulated on other
 * hosts. A local copy of another architecture is replaced when a native one
 * can be pulled (an older run may have pulled it emulated). Returns the
 * architecture used.
 */
export async function ensureImage(image) {
  const host = await hostArch();
  const local = await localArch(image);
  if (local === host && !options.pull) return { image, arch: local, emulated: false };
  log(`pulling ${image} for linux/${host}`);
  let result = await run('docker', ['pull', '-q', '--platform', `linux/${host}`, image]);
  if (result.code === 0) return { image, arch: host, emulated: false };
  if (local && !options.pull) {
    log(`${image} has no linux/${host} image; using the local linux/${local} one (emulated)`);
    return { image, arch: local, emulated: true };
  }
  if (host !== 'amd64') {
    log(`${image} has no linux/${host} image; pulling linux/amd64 to run emulated`);
    result = await run('docker', ['pull', '-q', '--platform', 'linux/amd64', image]);
    if (result.code === 0) return { image, arch: 'amd64', emulated: true };
  }
  throw new Error(`docker pull ${image} failed: ${result.stderr}`);
}

export async function buildFromSource(app, version) {
  // Named after the compose project, so runs with --project never share an image.
  const image = `${PROJECT}-${app}:to`;
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from source (${version}, ${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run('docker', [
      'build',
      '-q',
      // Natively, whatever DOCKER_DEFAULT_PLATFORM says: both Dockerfiles
      // build on amd64 and arm64.
      '--platform',
      `linux/${await hostArch()}`,
      '-f',
      `docker/${app}.Dockerfile`,
      '--build-arg',
      `OCI_VERSION=${version}`,
      '--build-arg',
      `OCI_REVISION=${revision}`,
      '-t',
      image,
      '.',
    ]),
    `building ${image}`,
  );
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return image;
}

export async function readJournal(image) {
  const r = await must(
    run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'cat',
      image,
      '/app/packages/db/drizzle/meta/_journal.json',
    ]),
    `reading the migration journal of ${image}`,
  );
  return JSON.parse(r.stdout).entries;
}
