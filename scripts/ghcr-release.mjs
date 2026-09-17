// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Direct Actions script; registry secrets must not enter Turbo tasks.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertStableTag } from './release-target.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Only a root-manifest 404 means absence; auth, network and child errors fail. */
export function registryClient(image, username, password, fetcher = fetch) {
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_./-]+$/.test(image))
    throw new Error('Expected a GHCR image');
  const name = image.slice('ghcr.io/'.length);
  let token;
  async function headers() {
    if (!token) {
      if (!username || !password) throw new Error('GHCR credentials are required');
      const url = new URL('https://ghcr.io/token');
      url.searchParams.set('service', 'ghcr.io');
      url.searchParams.set('scope', `repository:${name}:pull`);
      const response = await fetcher(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
      });
      if (!response.ok) throw new Error(`GHCR token request failed (${response.status})`);
      const body = await response.json();
      token = body.token ?? body.access_token;
      if (!token) throw new Error('GHCR did not return an access token');
    }
    return { Authorization: `Bearer ${token}`, Accept: manifestTypes };
  }
  async function manifest(ref, optional = false) {
    const response = await fetcher(
      `https://ghcr.io/v2/${name}/manifests/${encodeURIComponent(ref)}`,
      { headers: await headers() },
    );
    if (response.status === 404 && optional) return null;
    if (!response.ok) throw new Error(`Cannot read GHCR manifest ${ref} (${response.status})`);
    const digest = response.headers.get('docker-content-digest');
    if (!digestPattern.test(digest ?? ''))
      throw new Error('GHCR returned no valid manifest digest');
    if (digestPattern.test(ref) && digest !== ref)
      throw new Error('GHCR returned an unexpected manifest digest');
    return { digest, body: await response.json() };
  }
  async function config(root) {
    let runnable = root;
    if (root.body.manifests) {
      const images = root.body.manifests.filter((entry) => entry.platform?.os !== 'unknown');
      if (
        images.length !== 1 ||
        images[0].platform?.os !== 'linux' ||
        images[0].platform?.architecture !== 'amd64'
      ) {
        throw new Error('Expected exactly one linux/amd64 image plus optional attestations');
      }
      runnable = await manifest(images[0].digest);
    }
    const digest = runnable.body.config?.digest;
    if (!digestPattern.test(digest ?? '')) throw new Error('Image config digest is missing');
    const response = await fetcher(`https://ghcr.io/v2/${name}/blobs/${digest}`, {
      headers: await headers(),
    });
    if (!response.ok) throw new Error(`Cannot read image config (${response.status})`);
    return response.json();
  }
  return { manifest, config };
}

export async function verifyImage(client, root, { tag, sha, source }) {
  const config = await client.config(root);
  const labels = config.config?.Labels ?? {};
  if (
    config.os !== 'linux' ||
    config.architecture !== 'amd64' ||
    labels['org.opencontainers.image.revision'] !== sha ||
    labels['org.opencontainers.image.version'] !== tag ||
    labels['org.opencontainers.image.source'] !== source
  ) {
    throw new Error('Existing/candidate image platform or OCI labels do not match this release');
  }
}

/** Reuse verified immutable aliases on retries; never overwrite either one. */
export async function publishRelease({ client, candidate, tag, sha, source, putAlias }) {
  assertStableTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sha) || !digestPattern.test(candidate))
    throw new Error('Invalid release digest or commit');
  const shortSha = sha.slice(0, 8);
  const [version, commit] = await Promise.all([
    client.manifest(tag, true),
    client.manifest(shortSha, true),
  ]);
  for (const root of [version, commit].filter(Boolean))
    await verifyImage(client, root, { tag, sha, source });
  if (version && commit && version.digest !== commit.digest)
    throw new Error('Immutable version and SHA tags disagree');
  const canonical = version ?? commit ?? (await client.manifest(candidate));
  await verifyImage(client, canonical, { tag, sha, source });
  for (const [alias, existing] of [
    [tag, version],
    [shortSha, commit],
  ]) {
    if (existing) continue;
    await putAlias(alias, canonical.digest);
    if ((await client.manifest(alias)).digest !== canonical.digest)
      throw new Error('Published alias digest changed unexpectedly');
  }
  return canonical.digest;
}

export async function promoteLatest({ client, tag, sha, source, putAlias }) {
  assertStableTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid commit');
  const root = await client.manifest(tag);
  await verifyImage(client, root, { tag, sha, source });
  const commit = await client.manifest(sha.slice(0, 8));
  if (root.digest !== commit.digest) throw new Error('Immutable version and SHA tags disagree');
  await putAlias('latest', root.digest);
  if ((await client.manifest('latest')).digest !== root.digest)
    throw new Error('Latest digest changed unexpectedly');
  return root.digest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const image = process.env.IMAGE;
  const client = registryClient(image, process.env.GHCR_USERNAME, process.env.GHCR_TOKEN);
  const params = {
    client,
    tag: process.env.RELEASE_TAG,
    sha: process.env.RELEASE_SHA,
    source: `https://github.com/${process.env.GITHUB_REPOSITORY}`,
    putAlias: (alias, digest) =>
      execFileSync(
        'docker',
        [
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          '-t',
          `${image}:${alias}`,
          `${image}@${digest}`,
        ],
        { stdio: 'inherit' },
      ),
  };
  const digest =
    process.argv[2] === 'latest'
      ? await promoteLatest(params)
      : await publishRelease({ ...params, candidate: process.env.CANDIDATE_DIGEST });
  console.log(`${image}: ${digest}`);
}
