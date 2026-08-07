import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStorageKey } from '../../services/storage/driver.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

describe('integration: local attachment storage path safety', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oci-storage-test-'));
    driver = new LocalStorageDriver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads an owner-namespaced object inside the configured root', async () => {
    const key = buildStorageKey('owner-1', 'attachment-1', '../../Report.PDF');
    const body = Buffer.from('stored content');

    expect(key).toBe('owner-1/attachment-1.pdf');
    await expect(driver.put(key, body, 'application/pdf')).resolves.toEqual({
      key,
      sizeBytes: body.byteLength,
    });
    await expect(driver.get(key)).resolves.toEqual(body);
    await expect(readFile(join(root, key))).resolves.toEqual(body);
  });

  it.each(['../outside.txt', '/tmp/outside.txt', 'owner/../../../outside.txt'])(
    'blocks traversal key %s for writes',
    async (key) => {
      await expect(driver.put(key, Buffer.from('escape'), 'text/plain')).rejects.toThrow(
        'escapes the storage root',
      );
    },
  );

  it('does not disclose path details when an unsafe or missing key is read', async () => {
    await expect(driver.get('../outside.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: 'Attachment file is missing from storage',
    });
  });
});
