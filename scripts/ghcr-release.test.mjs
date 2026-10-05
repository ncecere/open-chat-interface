import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promoteLatest, publishRelease, registryClient } from './ghcr-release.mjs';

const tag = 'v0.4.1';
const sha = 'a'.repeat(40);
const source = 'https://github.com/owner/repo';
const first = `sha256:${'1'.repeat(64)}`;
const rebuilt = `sha256:${'2'.repeat(64)}`;
const platforms = (arm64Labels = labels, amd64Labels = labels) => [
  {
    platform: 'linux/amd64',
    config: { os: 'linux', architecture: 'amd64', config: { Labels: amd64Labels } },
  },
  {
    platform: 'linux/arm64',
    config: { os: 'linux', architecture: 'arm64', config: { Labels: arm64Labels } },
  },
];
const labels = {
  'org.opencontainers.image.version': tag,
  'org.opencontainers.image.revision': sha,
  'org.opencontainers.image.source': source,
};

function fixture(existing = {}) {
  const tags = new Map(Object.entries(existing));
  const writes = [];
  const client = {
    manifest: async (ref, optional = false) => {
      const digest = ref.startsWith('sha256:') ? ref : tags.get(ref);
      if (!digest) {
        if (optional) return null;
        throw new Error('missing required manifest');
      }
      return { digest, body: {} };
    },
    configs: async () => platforms(),
  };
  const putAlias = async (alias, digest) => {
    writes.push([alias, digest]);
    tags.set(alias, digest);
  };
  return { client, tag, sha, source, candidate: rebuilt, putAlias, writes };
}

test('first publication assigns version and SHA from the same digest, not latest', async () => {
  const f = fixture();
  assert.equal(await publishRelease(f), rebuilt);
  assert.deepEqual(f.writes, [
    [tag, rebuilt],
    [sha.slice(0, 8), rebuilt],
  ]);
});

test('reruns retain both immutable tags even if the rebuild digest differs', async () => {
  const f = fixture({ [tag]: first, [sha.slice(0, 8)]: first });
  assert.equal(await publishRelease(f), first);
  assert.deepEqual(f.writes, []);
});

test('partial publication repairs only the missing counterpart from the existing digest', async () => {
  for (const alias of [tag, sha.slice(0, 8)]) {
    const f = fixture({ [alias]: first });
    assert.equal(await publishRelease(f), first);
    assert.deepEqual(f.writes, [[alias === tag ? sha.slice(0, 8) : tag, first]]);
  }
});

test('conflicting immutable digests fail without writing', async () => {
  const f = fixture({ [tag]: first, [sha.slice(0, 8)]: rebuilt });
  await assert.rejects(publishRelease(f), /disagree/);
  assert.deepEqual(f.writes, []);
});

test('missing/wrong revision, source, version or platform fails closed', async () => {
  for (const [field, value] of [
    ['org.opencontainers.image.version', 'v0.4.0'],
    ['org.opencontainers.image.revision', undefined],
    ['org.opencontainers.image.source', 'https://example.test'],
  ]) {
    // On either platform's image.
    for (const wrongArm64 of [true, false]) {
      const f = fixture({ [tag]: first });
      const wrong = { ...labels, [field]: value };
      f.client.configs = async () => (wrongArm64 ? platforms(wrong) : platforms(labels, wrong));
      await assert.rejects(publishRelease(f), /do not match/);
      assert.deepEqual(f.writes, []);
    }
  }
  // An image whose config is for another architecture than its index entry.
  const f = fixture();
  f.client.configs = async () => [
    platforms()[0],
    {
      platform: 'linux/arm64',
      config: { os: 'linux', architecture: 'amd64', config: { Labels: labels } },
    },
  ];
  await assert.rejects(publishRelease(f), /do not match/);
  // An amd64-only release (as before v0.11) is not a complete release.
  const amd64Only = fixture({ [tag]: first, [sha.slice(0, 8)]: first });
  amd64Only.client.configs = async () => [platforms()[0]];
  await assert.rejects(publishRelease(amd64Only), /platforms do not match/);
  await assert.rejects(promoteLatest(amd64Only), /platforms do not match/);
  assert.deepEqual(amd64Only.writes, []);
});

test('latest uses the verified existing release digest, never the rebuild candidate', async () => {
  const f = fixture({ [tag]: first, [sha.slice(0, 8)]: first });
  assert.equal(await promoteLatest(f), first);
  assert.deepEqual(f.writes, [['latest', first]]);
});

test('failed alias creation does not continue to another alias', async () => {
  const f = fixture();
  f.putAlias = async () => {
    throw new Error('Registry write failed');
  };
  await assert.rejects(publishRelease(f), /Registry write failed/);
});

function registryFixture(status = 200) {
  return registryClient('ghcr.io/owner/repo/api', 'test', 'test-token', async (url) => {
    if (String(url).includes('/token?')) return Response.json({ token: 'temporary-token' });
    return new Response('{}', { status, headers: { 'docker-content-digest': first } });
  });
}

test('only optional root manifest 404 is interpreted as absence', async () => {
  assert.equal(await registryFixture(404).manifest(tag, true), null);
  await assert.rejects(registryFixture(404).manifest(first), /Cannot read/);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(registryFixture(status).manifest(tag, true), /Cannot read/);
  }
});

test('token authorization failure cannot become permission to overwrite tags', async () => {
  const client = registryClient(
    'ghcr.io/owner/repo/api',
    'test',
    'test-token',
    async () => new Response('', { status: 403 }),
  );
  await assert.rejects(client.manifest(tag, true), /token request failed/);
});

function indexClient(configsByDigest) {
  return registryClient('ghcr.io/owner/repo/api', 'test', 'test-token', async (url) => {
    const text = String(url);
    if (text.includes('/token?')) return Response.json({ token: 'temporary-token' });
    const manifestDigest = text.match(
      /manifests\/(sha256%3A[a-f0-9]{64}|sha256:[a-f0-9]{64})/,
    )?.[1];
    if (manifestDigest) {
      const digest = decodeURIComponent(manifestDigest);
      return Response.json(
        { config: { digest: configsByDigest[digest]?.digest } },
        { headers: { 'docker-content-digest': digest } },
      );
    }
    const blob = Object.values(configsByDigest).find((entry) => text.endsWith(entry.digest));
    return blob ? Response.json(blob.config) : new Response('', { status: 404 });
  });
}

const amd64Image = `sha256:${'4'.repeat(64)}`;
const arm64Image = `sha256:${'5'.repeat(64)}`;
const attestation = `sha256:${'6'.repeat(64)}`;
const configFor = (architecture, n) => ({
  digest: `sha256:${String(n).repeat(64)}`,
  config: { os: 'linux', architecture, config: { Labels: labels } },
});
const releaseIndex = (entries) => ({ digest: first, body: { manifests: entries } });

test('a release index resolves each runnable image and skips attestations', async () => {
  const client = indexClient({
    [amd64Image]: configFor('amd64', 7),
    [arm64Image]: configFor('arm64', 8),
  });
  const index = releaseIndex([
    { digest: amd64Image, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: arm64Image, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
    { digest: attestation, platform: { os: 'unknown', architecture: 'unknown' } },
  ]);
  const images = await client.configs(index);
  assert.deepEqual(
    images.map(({ platform, config }) => [platform, config.architecture]),
    [
      ['linux/amd64', 'amd64'],
      ['linux/arm64', 'arm64'],
    ],
  );
});

test('indexes without exactly one amd64 and one arm64 image are refused', async () => {
  const client = indexClient({ [amd64Image]: configFor('amd64', 7) });
  const amd64 = { digest: amd64Image, platform: { os: 'linux', architecture: 'amd64' } };
  const arm64 = { digest: arm64Image, platform: { os: 'linux', architecture: 'arm64' } };
  for (const entries of [
    [amd64],
    [arm64],
    [amd64, amd64],
    [amd64, arm64, { digest: attestation, platform: { os: 'linux', architecture: 's390x' } }],
    [],
  ]) {
    await assert.rejects(client.configs(releaseIndex(entries)), /exactly one image each/);
  }
  // A single-platform manifest is not a release image any more.
  await assert.rejects(client.configs({ digest: first, body: {} }), /multi-platform index/);
});

test('a runnable image whose config cannot be read fails', async () => {
  const client = indexClient({ [amd64Image]: configFor('amd64', 7) });
  const index = releaseIndex([
    { digest: amd64Image, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: arm64Image, platform: { os: 'linux', architecture: 'arm64' } },
  ]);
  await assert.rejects(client.configs(index), /config digest is missing|Cannot read image config/);
});
