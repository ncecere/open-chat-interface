import { createHash, randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { StorageDriver } from '../storage/driver.js';
import type { S3StorageDriver } from '../storage/s3-driver.js';

/**
 * Attachment files in backups (v0.10): copies of attachment objects at the
 * backup destination, content addressed by SHA-256 under `<root>objects/`.
 *
 * - An object is copied only when its SHA-256 is not at the destination yet,
 *   so after the first backup each run copies only new files, and a file
 *   uploaded twice is stored once.
 * - Copies stream from the attachment storage to the destination (at most one
 *   multipart part in memory) and are checksummed on the way: bytes that do
 *   not match the expected SHA-256 never complete an object.
 * - Retention deletes backup folders; the sweep afterwards deletes copies no
 *   retained backup's manifest references.
 *
 * See docs/admin/backups.md and docs/dev/v0.10-design.md ("Backups include files").
 */

/** Folder, below the backup root, holding the copied files. */
export const BACKUP_OBJECTS_FOLDER = 'objects/';

export const objectsPrefix = (root: string) => `${root}${BACKUP_OBJECTS_FOLDER}`;
export const backupObjectKey = (root: string, sha256: string) => `${objectsPrefix(root)}${sha256}`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One line of `attachments.jsonl`. */
export interface ManifestLine {
  attachmentId?: string | null;
  key: string;
  kind: string;
  bytes?: number;
  sha256?: string;
  missing?: boolean;
  error?: string;
}

/** Raised when an attachment object cannot be read from attachment storage. */
export class SourceReadError extends Error {
  constructor(readonly key: string) {
    super(`${key} could not be read from attachment storage.`);
  }
}

/** Re-raises any failure to read `source` as a `SourceReadError`. */
async function* tagSourceErrors(
  source: AsyncIterable<Uint8Array>,
  key: string,
): AsyncGenerator<Uint8Array> {
  try {
    yield* source;
  } catch {
    throw new SourceReadError(key);
  }
}

/** Raised when bytes do not match the SHA-256 and size they are stored under. */
export class ChecksumMismatchError extends Error {
  constructor(readonly key: string) {
    super(`The bytes of ${key} do not match their recorded SHA-256.`);
  }
}

export async function readObject(
  driver: StorageDriver,
  key: string,
): Promise<AsyncIterable<Uint8Array>> {
  if (driver.getStream) return (await driver.getStream(key)) as AsyncIterable<Uint8Array>;
  return Readable.from([await driver.get(key)]);
}

/**
 * Passes `source` through, and throws at the end, before the consumer sees
 * the stream finish, when its size or SHA-256 differ from what was expected.
 * Every `putStream` aborts on a throwing source, so a mismatch stores nothing.
 */
export async function* verifiedStream(
  source: AsyncIterable<Uint8Array>,
  expected: { sha256: string; bytes: number; key: string },
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of source) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    yield chunk;
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw new ChecksumMismatchError(expected.key);
}

/** SHA-256 and size of a stored object, read as a stream. */
export async function checksumStored(driver: StorageDriver, key: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of await readObject(driver, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Runs `task` over `items` with at most `limit` at a time, in order of start. */
export async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type CopyOutcome = 'copied' | 'skipped';

/**
 * Copies one attachment object to `<root>objects/<sha256>` unless it is
 * there already. Throws `ChecksumMismatchError` when the source no longer
 * matches its recorded checksum and `SourceReadError` when it cannot be
 * read; a destination error (the upload) is thrown as is.
 */
export async function copyObjectToBackup(
  source: StorageDriver,
  destination: { driver: S3StorageDriver; root: string },
  object: { key: string; sha256: string; bytes: number },
): Promise<CopyOutcome> {
  const target = backupObjectKey(destination.root, object.sha256);
  if (await destination.driver.exists(target)) return 'skipped';
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await readObject(source, object.key);
  } catch {
    throw new SourceReadError(object.key);
  }
  await destination.driver.putStream(
    target,
    verifiedStream(tagSourceErrors(stream, object.key), object),
    'application/octet-stream',
  );
  return 'copied';
}

/**
 * Parses a JSON Lines object as a stream, a line at a time, so a manifest of
 * millions of attachments is never held whole.
 */
export async function* readManifestLines(
  driver: StorageDriver,
  key: string,
): AsyncGenerator<ManifestLine> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  for await (const chunk of await readObject(driver, key)) {
    buffered += decoder.write(Buffer.from(chunk));
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield JSON.parse(line) as ManifestLine;
      newline = buffered.indexOf('\n');
    }
  }
  const rest = (buffered + decoder.end()).trim();
  if (rest) yield JSON.parse(rest) as ManifestLine;
}

/** A line whose object a backup holds a copy of. */
export const copiedEntry = (
  line: ManifestLine,
): line is ManifestLine & { sha256: string; bytes: number } =>
  !line.missing && typeof line.sha256 === 'string' && SHA256_HEX.test(line.sha256);

/**
 * Reads copied files back from the destination and checks their size and
 * SHA-256: every file the manifest references (`all`), or a random sample of
 * `sampleSize` (reservoir sampling over the manifest, so the choice is
 * uniform without holding the manifest). Each distinct file is read once.
 * Returns how many were checked and how many failed.
 */
export async function verifyBackupObjects(
  destination: { driver: S3StorageDriver; root: string },
  manifestKey: string,
  mode: 'sample' | 'all',
  sampleSize: number,
): Promise<{ checked: number; failed: number }> {
  let checked = 0;
  let failed = 0;
  const check = async (entry: { sha256: string; bytes: number }) => {
    checked += 1;
    try {
      const stored = await checksumStored(
        destination.driver,
        backupObjectKey(destination.root, entry.sha256),
      );
      if (stored.sha256 !== entry.sha256 || stored.bytes !== entry.bytes) failed += 1;
    } catch {
      failed += 1;
    }
  };

  const seen = new Set<string>();
  const sample: Array<{ sha256: string; bytes: number }> = [];
  let candidates = 0;
  let batch: Array<{ sha256: string; bytes: number }> = [];
  for await (const line of readManifestLines(destination.driver, manifestKey)) {
    if (!copiedEntry(line) || seen.has(line.sha256)) continue;
    seen.add(line.sha256);
    const entry = { sha256: line.sha256, bytes: line.bytes };
    if (mode === 'all') {
      batch.push(entry);
      if (batch.length >= 16) {
        await eachLimit(batch, 4, check);
        batch = [];
      }
      continue;
    }
    candidates += 1;
    if (sample.length < sampleSize) sample.push(entry);
    else {
      const slot = randomInt(candidates);
      if (slot < sampleSize) sample[slot] = entry;
    }
  }
  await eachLimit(mode === 'all' ? batch : sample, 4, check);
  return { checked, failed };
}

/**
 * Mark and sweep: deletes copies under `<root>objects/` that none of
 * `manifestKeys` (the `attachments.jsonl` of every retained backup that
 * copied files) references. Throws, deleting nothing, when any of those
 * manifests cannot be read, since its references are then unknown.
 *
 * The caller holds the backup job lock, which keeps another backup from
 * copying meanwhile. As a second line of defence (the lock is a PostgreSQL
 * session lock, and a backup that lost its connection may still be writing)
 * only objects last modified before `olderThan` are candidates: the caller
 * passes a day ago, so a copy whose manifest is not written yet is never
 * taken, and S3 clock skew does not matter. Names that are not a SHA-256 are
 * left alone.
 */
export async function sweepBackupObjects(
  destination: { driver: S3StorageDriver; root: string },
  manifestKeys: readonly string[],
  olderThan: Date,
): Promise<number> {
  const referenced = new Set<string>();
  for (const key of manifestKeys)
    for await (const line of readManifestLines(destination.driver, key))
      if (copiedEntry(line)) referenced.add(line.sha256);

  const prefix = objectsPrefix(destination.root);
  let swept = 0;
  let cursor: string | undefined;
  do {
    const page = await destination.driver.list({ prefix, cursor, limit: 1_000 });
    cursor = page.cursor;
    const unreferenced = page.objects.filter((object) => {
      const name = object.key.slice(prefix.length);
      return (
        object.key.startsWith(prefix) &&
        SHA256_HEX.test(name) &&
        !referenced.has(name) &&
        object.lastModified.getTime() < olderThan.getTime()
      );
    });
    for (const object of unreferenced) {
      await destination.driver.delete(object.key);
      swept += 1;
    }
  } while (cursor);
  return swept;
}
