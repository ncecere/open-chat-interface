import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from '../src/services/storage/s3-driver.js';
import { containerRunning } from './live-postgres.js';

/**
 * Shared by the backup live tests: where MinIO is (the same configuration as
 * `s3-storage.live.test.ts`) and where PostgreSQL's client tools are.
 */
export const liveS3Config = {
  bucket: process.env.MINIO_TEST_BUCKET ?? 'oci-test-attachments',
  region: 'us-east-1',
  endpoint:
    process.env.S3_TEST_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_TEST_PORT ?? '9020'}`,
  accessKeyId: process.env.MINIO_ROOT_USER ?? process.env.MINIO_TEST_ROOT_USER ?? 'oci_test',
  secretAccessKey:
    process.env.MINIO_ROOT_PASSWORD ?? process.env.MINIO_TEST_ROOT_PASSWORD ?? 'oci_test_password',
  forcePathStyle: true,
};

export function liveS3Client(): S3Client {
  return new S3Client({
    region: liveS3Config.region,
    endpoint: liveS3Config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: liveS3Config.accessKeyId,
      secretAccessKey: liveS3Config.secretAccessKey,
    },
  });
}

/** Creates a bucket if it does not exist yet. */
export async function ensureBucket(bucket: string): Promise<void> {
  const client = liveS3Client();
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  } finally {
    client.destroy();
  }
}

/** True when MinIO answers; suites skip otherwise (CI has no MinIO service). */
export async function liveS3Available(): Promise<boolean> {
  if (!process.env.S3_TEST_ENDPOINT && !containerRunning('oci-auth-test-minio')) return false;
  try {
    await ensureBucket(liveS3Config.bucket);
    await new S3StorageDriver(liveS3Config).checkReadAccess();
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory with both pg_dump and pg_restore: `BACKUP_PG_BIN_DIR`, then
 * PATH, then the usual Homebrew and Debian locations.
 */
export function findPgBinDir(): string | null {
  let fromPath: string | null = null;
  try {
    fromPath = dirname(
      execFileSync('which', ['pg_dump'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    fromPath = null;
  }
  const candidates = [
    process.env.BACKUP_PG_BIN_DIR,
    fromPath,
    '/opt/homebrew/opt/libpq/bin',
    '/usr/local/opt/libpq/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/18/bin',
    '/usr/lib/postgresql/17/bin',
  ];
  return (
    candidates.find(
      (dir): dir is string =>
        Boolean(dir) && existsSync(join(dir!, 'pg_dump')) && existsSync(join(dir!, 'pg_restore')),
    ) ?? null
  );
}
