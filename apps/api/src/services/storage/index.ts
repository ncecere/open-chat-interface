import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { decryptSecret } from '../../lib/crypto.js';
import { getSetting, type S3StorageSettings } from '../settings.js';
import { getS3ConfigurationIssues } from './config.js';
import type { StorageDriver } from './driver.js';
import { LocalStorageDriver } from './local-driver.js';
import { S3StorageDriver } from './s3-driver.js';

export type { StorageDriver } from './driver.js';
export { buildStorageKey } from './driver.js';

let cached: { driver: StorageDriver; signature: string } | null = null;

function createS3Driver(settings: S3StorageSettings): S3StorageDriver {
  const issues = getS3ConfigurationIssues(settings);
  if (issues.length > 0) {
    throw new Error(
      `Invalid S3 storage configuration: ${issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  let secretAccessKey: string;
  try {
    // The validation above guarantees this is present.
    secretAccessKey = decryptSecret(settings.encryptedSecretAccessKey as string);
  } catch {
    throw new Error('The S3 secret access key could not be decrypted');
  }

  return new S3StorageDriver({
    bucket: settings.bucket,
    region: settings.region,
    endpoint: settings.endpoint,
    accessKeyId: settings.accessKeyId,
    secretAccessKey,
    forcePathStyle: settings.forcePathStyle,
  });
}

/** Resolves exactly the configured driver; an invalid S3 configuration never falls back locally. */
export async function getStorageDriver(): Promise<StorageDriver> {
  const storage = await getSetting('storage');
  const signature = JSON.stringify({ driver: storage.driver, s3: storage.s3 });
  if (cached?.signature === signature) return cached.driver;

  if (storage.driver === 's3') {
    const driver = createS3Driver(storage.s3);
    cached = { driver, signature };
    return driver;
  }

  const rootPath = loadEnv().STORAGE_LOCAL_PATH;
  await LocalStorageDriver.ensureRoot(rootPath);
  const driver = new LocalStorageDriver(rootPath);
  cached = { driver, signature };
  return driver;
}

export type S3HealthCheckMode = 'read' | 'write';

/** Tests saved S3 settings. Write mode uses a random reserved key and always attempts cleanup. */
export async function testConfiguredS3Storage(mode: S3HealthCheckMode): Promise<void> {
  const storage = await getSetting('storage');
  const driver = createS3Driver(storage.s3);

  if (mode === 'read') {
    await driver.checkReadAccess();
    return;
  }

  const key = `.oci-health-check/${randomUUID()}`;
  const body = randomBytes(32);
  let objectCreated = false;
  try {
    await driver.put(key, body, 'application/octet-stream');
    objectCreated = true;
    const stored = await driver.get(key);
    if (!stored.equals(body))
      throw new Error('S3 health-check object did not round trip correctly');
  } finally {
    if (objectCreated) await driver.delete(key);
  }
}

export function invalidateStorageDriver(): void {
  cached = null;
}
