import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { StorageDriver } from '../storage/driver.js';
import { LocalStorageDriver } from '../storage/local-driver.js';
import { S3StorageDriver } from '../storage/s3-driver.js';
import {
  BACKUP_OBJECTS_FOLDER,
  ChecksumMismatchError,
  copiedEntry,
  eachLimit,
  type ManifestLine,
  readManifestLines,
  readObject,
  verifiedStream,
} from './files.js';

/**
 * Restores attachment files from a backup into attachment storage: for each
 * line of the backup's `attachments.jsonl`, the copy at
 * `<root>objects/<sha256>` is streamed to its original storage key and
 * checksummed on the way. Used by `pnpm --filter @oci/api backup:restore-files`
 * (src/scripts/restore-backup-files.ts); see docs/admin/backups.md, "Restoring".
 *
 * Needs no database: everything comes from the backup folder.
 */

export interface RestoreFilesOptions {
  /** The backup bucket. */
  backup: StorageDriver;
  /** Key of the backup folder, such as `oci-backups/2026-10-02T03-00-04-123Z-ab12cd34/`. */
  folder: string;
  /** Where attachments are restored to: the local storage directory or the attachment bucket. */
  target: StorageDriver;
  /** Report what would be restored without writing. */
  dryRun?: boolean;
  /** Replace objects already present at the target (by default they are left alone). */
  overwrite?: boolean;
  concurrency?: number;
}

export interface RestoreFilesResult {
  /** Objects listed in the manifest with a copy. */
  objects: number;
  restored: number;
  restoredBytes: number;
  /** Already present at the target and left alone. */
  present: number;
  /** Listed as missing when the backup was made, so it has no copy. */
  missingInBackup: number;
  /** No copy in the backup, a copy that did not match its checksum, or a write that failed. */
  failed: Array<{ key: string; reason: string }>;
}

function normalizeFolder(folder: string): string {
  const trimmed = folder.replace(/^\/+/, '');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** The backup root: the folder's parent, where `objects/` lives. */
function rootOf(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

interface BackupManifest {
  format?: string;
  attachments?: { sha256?: string; bytes?: number };
  files?: { copied?: boolean };
}

async function readJson(driver: StorageDriver, key: string): Promise<BackupManifest> {
  let text = '';
  try {
    for await (const chunk of await readObject(driver, key))
      text += Buffer.from(chunk).toString('utf8');
  } catch {
    throw new Error(`No backup manifest at ${key}. Check the folder and the bucket.`);
  }
  return JSON.parse(text) as BackupManifest;
}

export async function restoreAttachmentFiles(
  options: RestoreFilesOptions,
): Promise<RestoreFilesResult> {
  const folder = normalizeFolder(options.folder);
  const manifest = await readJson(options.backup, `${folder}manifest.json`);
  if (!manifest.files?.copied)
    throw new Error(
      'This backup did not copy attachment files (copying was off when it was made); restore them from your storage’s own protection.',
    );

  // The attachment manifest must be exactly the one the backup recorded.
  const attachmentsKey = `${folder}attachments.jsonl`;
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of await readObject(options.backup, attachmentsKey)) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  if (hash.digest('hex') !== manifest.attachments?.sha256 || size !== manifest.attachments?.bytes)
    throw new Error('attachments.jsonl does not match the checksum in manifest.json.');

  const objects = `${rootOf(folder)}${BACKUP_OBJECTS_FOLDER}`;
  const result: RestoreFilesResult = {
    objects: 0,
    restored: 0,
    restoredBytes: 0,
    present: 0,
    missingInBackup: 0,
    failed: [],
  };
  const putStream = options.target.putStream?.bind(options.target);
  if (!putStream) throw new Error('The target storage cannot write streams.');

  const restoreOne = async (line: ManifestLine & { sha256: string; bytes: number }) => {
    if (!options.overwrite && (await options.target.exists(line.key))) {
      result.present += 1;
      return;
    }
    if (options.dryRun) {
      result.restored += 1;
      result.restoredBytes += line.bytes;
      return;
    }
    let source: AsyncIterable<Uint8Array>;
    try {
      source = await readObject(options.backup, `${objects}${line.sha256}`);
    } catch {
      result.failed.push({ key: line.key, reason: 'no copy in the backup' });
      return;
    }
    try {
      await putStream(
        line.key,
        verifiedStream(source, { sha256: line.sha256, bytes: line.bytes, key: line.key }),
        'application/octet-stream',
      );
      result.restored += 1;
      result.restoredBytes += line.bytes;
    } catch (error) {
      result.failed.push({
        key: line.key,
        reason:
          error instanceof ChecksumMismatchError
            ? 'the copy does not match its checksum'
            : `write failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                200,
              ),
      });
    }
  };

  let batch: Array<ManifestLine & { sha256: string; bytes: number }> = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 32));
  for await (const line of readManifestLines(options.backup, attachmentsKey)) {
    if (!copiedEntry(line)) {
      result.missingInBackup += 1;
      continue;
    }
    result.objects += 1;
    batch.push(line);
    if (batch.length >= concurrency * 8) {
      await eachLimit(batch, concurrency, restoreOne);
      batch = [];
    }
  }
  await eachLimit(batch, concurrency, restoreOne);
  return result;
}

type Env = Record<string, string | undefined>;

const USAGE = `Usage: backup:restore-files <backup folder> (--to-local <directory> | --to-s3) [--dry-run] [--overwrite] [--concurrency <n>]

  <backup folder>  The folder of one backup in the backup bucket, such as
                   oci-backups/2026-10-02T03-00-04-123Z-ab12cd34/
                   or s3://bucket/oci-backups/2026-10-02T03-00-04-123Z-ab12cd34/
  --to-local       Restore into this local storage directory (STORAGE_LOCAL_PATH).
  --to-s3          Restore into the bucket named by the TARGET_S3_* variables.
  --dry-run        Report what would be restored; write nothing.
  --overwrite      Replace objects already present (by default they are kept).

The backup bucket comes from BACKUP_S3_BUCKET, BACKUP_S3_REGION,
BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY and
BACKUP_S3_FORCE_PATH_STYLE; a --to-s3 target from the same TARGET_S3_*
variables. Credentials are read from the environment only, never arguments.`;

function s3FromEnv(env: Env, prefix: 'BACKUP_S3' | 'TARGET_S3', bucket?: string): S3StorageDriver {
  const read = (name: string) => env[`${prefix}_${name}`]?.trim() || undefined;
  const config = {
    bucket: bucket ?? read('BUCKET'),
    region: read('REGION') ?? 'us-east-1',
    endpoint: read('ENDPOINT') ?? null,
    accessKeyId: read('ACCESS_KEY_ID'),
    secretAccessKey: read('SECRET_ACCESS_KEY'),
  };
  const absent = (['bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (field) => !config[field],
  );
  if (absent.length)
    throw new UsageError(
      `Set ${absent.map((field) => `${prefix}_${{ bucket: 'BUCKET', accessKeyId: 'ACCESS_KEY_ID', secretAccessKey: 'SECRET_ACCESS_KEY' }[field]}`).join(', ')}.`,
    );
  const pathStyle = read('FORCE_PATH_STYLE');
  return new S3StorageDriver({
    bucket: config.bucket!,
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId!,
    secretAccessKey: config.secretAccessKey!,
    ...(pathStyle ? { forcePathStyle: /^(1|true|yes)$/i.test(pathStyle) } : {}),
  });
}

class UsageError extends Error {}

/**
 * The command line: parses arguments, reads credentials from `env`, restores
 * and prints a summary. Returns the exit status: 0 when every listed copy was
 * restored or present, 1 when any failed, 2 for a usage or setup error.
 */
export async function runRestoreFilesCli(
  argv: string[],
  env: Env,
  print: (line: string) => void,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'to-local': { type: 'string' },
        'to-s3': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        overwrite: { type: 'boolean' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      print(USAGE);
      return 0;
    }
    if (positionals.length !== 1 || Boolean(values['to-local']) === Boolean(values['to-s3']))
      throw new UsageError(USAGE);

    let folder = positionals[0]!;
    let bucket: string | undefined;
    const url = /^s3:\/\/([^/]+)\/(.+)$/.exec(folder);
    if (url) {
      bucket = url[1];
      folder = url[2]!;
    }
    const concurrency = values.concurrency ? Number.parseInt(values.concurrency, 10) : 4;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new UsageError('--concurrency must be a positive whole number.');

    const backup = s3FromEnv(env, 'BACKUP_S3', bucket);
    const target: StorageDriver = values['to-local']
      ? new LocalStorageDriver(values['to-local'])
      : s3FromEnv(env, 'TARGET_S3');

    const result = await restoreAttachmentFiles({
      backup,
      folder,
      target,
      dryRun: values['dry-run'],
      overwrite: values.overwrite,
      concurrency,
    });
    const verb = values['dry-run'] ? 'Would restore' : 'Restored';
    print(
      `${verb} ${result.restored} of ${result.objects} files (${result.restoredBytes} bytes); ${result.present} already present; ${result.missingInBackup} listed as missing when the backup was made; ${result.failed.length} failed.`,
    );
    for (const failure of result.failed.slice(0, 50))
      print(`  failed: ${failure.key}: ${failure.reason}`);
    if (result.failed.length > 50) print(`  … and ${result.failed.length - 50} more`);
    return result.failed.length ? 1 : 0;
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
