import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promoteLatest, publishRelease, registryClient } from './ghcr-release.mjs';

const tag = 'v0.4.1';
const sha = 'a'.repeat(40);
const source = 'https://github.com/owner/repo';
const first = `sha256:${'1'.repeat(64)}`;
const rebuilt = `sha256:${'2'.repeat(64)}`;
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
    config: async () => ({ os: 'linux', architecture: 'amd64', config: { Labels: labels } }),
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
    const f = fixture({ [tag]: first });
    f.client.config = async () => ({
      os: 'linux',
      architecture: 'amd64',
      config: { Labels: { ...labels, [field]: value } },
    });
    await assert.rejects(publishRelease(f), /do not match/);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.client.config = async () => ({
    os: 'linux',
    architecture: 'arm64',
    config: { Labels: labels },
  });
  await assert.rejects(publishRelease(f), /do not match/);
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

test('attestation indexes resolve only the runnable image and reject missing child configs', async () => {
  const configDigest = `sha256:${'3'.repeat(64)}`;
  const index = {
    digest: first,
    body: {
      manifests: [
        { digest: rebuilt, platform: { os: 'linux', architecture: 'amd64' } },
        { digest: configDigest, platform: { os: 'unknown', architecture: 'unknown' } },
      ],
    },
  };
  const client = registryClient('ghcr.io/owner/repo/api', 'test', 'test-token', async (url) => {
    if (String(url).includes('/token?')) return Response.json({ token: 'temporary-token' });
    if (String(url).includes('/manifests/'))
      return Response.json(
        { config: { digest: configDigest } },
        { headers: { 'docker-content-digest': rebuilt } },
      );
    return new Response('', { status: 404 });
  });
  await assert.rejects(client.config(index), /Cannot read image config/);
  index.body.manifests[0].platform.architecture = 'arm64';
  await assert.rejects(client.config(index), /linux\/amd64/);
});
