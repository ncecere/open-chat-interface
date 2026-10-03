import { randomBytes, randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveS3Config as config, liveS3Available } from '../../../test/live-backup-tools.js';
import { S3StorageDriver } from '../../services/storage/s3-driver.js';

/**
 * Exercises the real S3 driver against an S3-compatible server: VersityGW in
 * CI, the MinIO fixture from `docker/compose.auth-test.yaml` locally (see
 * test/live-backup-tools.ts). The mocked suites assert configuration and
 * policy logic; these assert that the driver actually round trips bytes,
 * deletes objects, and fails cleanly against a genuine S3 API — behaviour a
 * stubbed `S3Client` can never prove.
 */
const available = await liveS3Available();

describe.skipIf(!available)('live S3: storage driver against S3-compatible storage', () => {
  const driver = new S3StorageDriver(config);
  // Namespaces this run so a failed cleanup cannot leak into the next one.
  const prefix = `live-test/${randomUUID()}`;
  const created = new Set<string>();

  /** Records the key so `afterAll` removes it even when an assertion throws. */
  async function put(key: string, body: Buffer, contentType = 'application/octet-stream') {
    created.add(key);
    return driver.put(key, body, contentType);
  }

  /** Lists every key in the bucket, used to prove where an object really landed. */
  async function listAllKeys(): Promise<string[]> {
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    try {
      // Every page: other suites share the bucket, so it can hold more than one.
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const result = await client.send(
          new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: token }),
        );
        for (const entry of result.Contents ?? []) if (entry.Key) keys.push(entry.Key);
        token = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (token);
      return keys;
    } finally {
      client.destroy();
    }
  }

  beforeAll(async () => {
    await driver.checkReadAccess();
  });

  afterAll(async () => {
    await Promise.all([...created].map((key) => driver.delete(key).catch(() => {})));
  });

  it('round trips binary content byte for byte', async () => {
    const key = `${prefix}/roundtrip.bin`;
    // Random bytes include null and high bytes that a text-mode bug would mangle.
    const body = randomBytes(64 * 1024);

    const stored = await put(key, body, 'image/png');
    expect(stored).toEqual({ key, sizeBytes: body.byteLength });

    const fetched = await driver.get(key);
    expect(fetched.equals(body)).toBe(true);
  });

  it('reports an object as existing only while it is stored', async () => {
    const key = `${prefix}/exists.txt`;
    expect(await driver.exists(key)).toBe(false);

    await put(key, Buffer.from('present'), 'text/plain');
    expect(await driver.exists(key)).toBe(true);
  });

  it('actually removes the object on delete', async () => {
    const key = `${prefix}/deleted.txt`;
    await put(key, Buffer.from('temporary'), 'text/plain');
    expect(await driver.exists(key)).toBe(true);

    await driver.delete(key);

    expect(await driver.exists(key)).toBe(false);
    expect(await listAllKeys()).not.toContain(key);
    // A second delete must stay quiet; S3 deletes are idempotent and cleanup
    // paths in the application call it without checking first.
    await expect(driver.delete(key)).resolves.toBeUndefined();
  });

  it('fails cleanly with a not-found error when the key is missing', async () => {
    const missing = `${prefix}/never-written-${randomUUID()}.txt`;

    // The driver translates every S3 failure into the application's 404, so a
    // deleted or never-written attachment never surfaces a raw SDK error.
    await expect(driver.get(missing)).rejects.toMatchObject({
      status: 404,
      message: 'Attachment file is missing from storage',
    });
  });

  it('rejects a path-traversal key instead of writing outside the prefix', async () => {
    const traversal = `${prefix}/../../../../etc/passwd`;
    const body = Buffer.from('not-a-real-password-file');

    // S3 servers validate the key and refuse a `..` component with a 400
    // (MinIO says XMinioInvalidResourceName, VersityGW a bare 400), so the
    // write fails outright rather than resolving elsewhere.
    await expect(driver.put(traversal, body, 'text/plain')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 400 },
    });

    // Nothing landed at the escaped target, nor anywhere else in the bucket.
    const keys = await listAllKeys();
    expect(keys).not.toContain('etc/passwd');
    expect(keys.some((key) => key.endsWith('etc/passwd'))).toBe(false);
    expect(await driver.exists('etc/passwd')).toBe(false);

    // Reading it back fails as the application's clean 404, not an SDK error.
    await expect(driver.get(traversal)).rejects.toMatchObject({ status: 404 });
  });

  it('treats an encoded or dotted key as a literal name under the prefix', async () => {
    // These are the traversal shapes S3 servers do accept, so the guarantee that
    // matters is that they stay opaque strings inside this run's namespace
    // rather than being collapsed into a parent path.
    const encoded = `${prefix}/%2e%2e/escaped.txt`;
    const dotted = `${prefix}/a..b.txt`;

    await put(encoded, Buffer.from('encoded'), 'text/plain');
    await put(dotted, Buffer.from('dotted'), 'text/plain');

    const keys = await listAllKeys();
    for (const key of [encoded, dotted]) {
      expect(keys).toContain(key);
      expect(key.startsWith(prefix)).toBe(true);
    }

    // Each key still resolves to its own object; neither overwrote the other.
    expect((await driver.get(encoded)).toString()).toBe('encoded');
    expect((await driver.get(dotted)).toString()).toBe('dotted');
  });
});
