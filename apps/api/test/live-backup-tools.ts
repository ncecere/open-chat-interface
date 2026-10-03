import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from '../src/services/storage/s3-driver.js';
import { containerRunning } from './live-postgres.js';

/**
 * Shared by the S3 live tests (storage, backups, compliance export): where the
 * S3-compatible server is and where PostgreSQL's client tools are. CI runs
 * VersityGW as a service (.github/workflows/ci.yml); locally the MinIO
 * fixture from docker/compose.auth-test.yaml or any server named by
 * `S3_TEST_ENDPOINT` will do. See docs/dev/testing.md.
 */
export const liveS3Config = {
  bucket: process.env.S3_TEST_BUCKET ?? process.env.MINIO_TEST_BUCKET ?? 'oci-test-attachments',
  region: 'us-east-1',
  endpoint:
    process.env.S3_TEST_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_TEST_PORT ?? '9020'}`,
  accessKeyId:
    process.env.S3_TEST_ACCESS_KEY_ID ??
    process.env.MINIO_ROOT_USER ??
    process.env.MINIO_TEST_ROOT_USER ??
    'oci_test',
  secretAccessKey:
    process.env.S3_TEST_SECRET_ACCESS_KEY ??
    process.env.MINIO_ROOT_PASSWORD ??
    process.env.MINIO_TEST_ROOT_PASSWORD ??
    'oci_test_password',
  forcePathStyle: true,
};

function liveS3Client(): S3Client {
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

/**
 * True when the S3 server answers (the test bucket is created if needed).
 * Locally the suites skip without one, so `pnpm test:live` works with only
 * PostgreSQL; in CI (`CI` set) an unreachable server is an error instead,
 * since a skipped S3 suite there would silently drop its coverage.
 */
export async function liveS3Available(): Promise<boolean> {
  const required = Boolean(process.env.CI);
  if (!process.env.S3_TEST_ENDPOINT && !containerRunning('oci-auth-test-minio')) {
    if (required) throw new Error('CI must provide S3 for the live suites: set S3_TEST_ENDPOINT.');
    return false;
  }
  try {
    await ensureBucket(liveS3Config.bucket);
    await new S3StorageDriver(liveS3Config).checkReadAccess();
    return true;
  } catch (error) {
    if (required)
      throw new Error(
        `The S3 test server at ${liveS3Config.endpoint} is not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
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
