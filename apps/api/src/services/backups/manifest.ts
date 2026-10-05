import { and, asc, eq, gt, inArray, ne, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { isManagedLogoKey } from '../branding-assets.js';
import { getSetting } from '../settings.js';
import type { StorageDriver } from '../storage/driver.js';
import { getStorageDriver } from '../storage/index.js';
import {
  ChecksumMismatchError,
  checksumStored,
  copyObjectToBackup,
  eachLimit,
  SourceReadError,
} from './files.js';
import type { BackupTarget } from './settings.js';

interface FileTotals {
  copiedObjects: number;
  copiedBytes: number;
  skippedObjects: number;
  skippedBytes: number;
}

export interface ManifestTotals {
  count: number;
  bytes: number;
  missing: number;
  /** Set when files are copied. */
  files: FileTotals | null;
}

const PAGE = 200;
/** Files copied at once; each holds at most one 16 MiB part in memory. */
const COPY_CONCURRENCY = 4;

type ManifestObject = {
  attachmentId: string | null;
  key: string;
  kind: 'file' | 'thumbnail' | 'logo';
};

/**
 * Manifest lines for one page of objects, copying each to the destination
 * first when `copyTo` is set. Checksums are cached per key, since attachment
 * objects are never rewritten, so each run reads only objects it has not
 * seen before; a copy is skipped when the destination already has its
 * SHA-256. An object that cannot be read, or whose bytes no longer match its
 * cached checksum, is listed as missing. A destination failure fails the run.
 */
async function manifestLines(
  source: StorageDriver,
  objects: ManifestObject[],
  totals: ManifestTotals,
  copyTo: BackupTarget | null,
): Promise<string> {
  if (objects.length === 0) return '';
  const cached = new Map(
    (
      await db
        .select()
        .from(schema.backupObjectChecksum)
        .where(
          inArray(
            schema.backupObjectChecksum.storageKey,
            objects.map((object) => object.key),
          ),
        )
    ).map((row) => [row.storageKey, row]),
  );

  const lines: string[] = new Array(objects.length);
  const inFlight = new Map<string, Promise<unknown>>();
  const missing = (index: number, error?: string) => {
    totals.missing += 1;
    lines[index] =
      `${JSON.stringify({ ...objects[index], missing: true, ...(error ? { error } : {}) })}\n`;
  };
  await eachLimit(
    objects.map((object, index) => ({ object, index })),
    copyTo ? COPY_CONCURRENCY : 1,
    async ({ object, index }) => {
      let entry = cached.get(object.key);
      if (!entry) {
        try {
          const measured = await checksumStored(source, object.key);
          entry = {
            storageKey: object.key,
            sizeBytes: measured.bytes,
            sha256: measured.sha256,
            computedAt: new Date(),
          };
          await db.insert(schema.backupObjectChecksum).values(entry).onConflictDoNothing();
        } catch {
          missing(index);
          return;
        }
      }
      if (copyTo && totals.files) {
        try {
          // Two objects with the same content copy once: the second waits for
          // the first, then finds the copy there.
          const earlier = inFlight.get(entry.sha256);
          if (earlier) await earlier.catch(() => undefined);
          const copying = copyObjectToBackup(source, copyTo, {
            key: object.key,
            sha256: entry.sha256,
            bytes: entry.sizeBytes,
          });
          inFlight.set(entry.sha256, copying);
          const outcome = await copying;
          if (outcome === 'copied') {
            totals.files.copiedObjects += 1;
            totals.files.copiedBytes += entry.sizeBytes;
          } else {
            totals.files.skippedObjects += 1;
            totals.files.skippedBytes += entry.sizeBytes;
          }
        } catch (error) {
          if (error instanceof SourceReadError) {
            missing(index);
            return;
          }
          if (error instanceof ChecksumMismatchError) {
            // Recomputed next run; this run has no trustworthy copy.
            await db
              .delete(schema.backupObjectChecksum)
              .where(eq(schema.backupObjectChecksum.storageKey, object.key));
            missing(index, 'checksum mismatch');
            return;
          }
          throw error;
        }
      }
      totals.count += 1;
      totals.bytes += entry.sizeBytes;
      lines[index] =
        `${JSON.stringify({ ...object, bytes: entry.sizeBytes, sha256: entry.sha256 })}\n`;
    },
  );
  return lines.join('');
}

/**
 * One JSON line per attachment object (file and thumbnail), then the
 * instance logo if one was uploaded: key, size and SHA-256.
 * No file names or other content are written.
 */
export async function* attachmentManifest(
  totals: ManifestTotals,
  copyTo: BackupTarget | null,
): AsyncGenerator<Uint8Array> {
  const source = await getStorageDriver();
  let after = '';
  for (;;) {
    const rows = await db
      .select({
        id: schema.attachment.id,
        storageKey: schema.attachment.storageKey,
        thumbnailKey: schema.attachment.thumbnailKey,
      })
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.uploadPending, false),
          ne(schema.attachment.storageKey, 'pending'),
          gt(schema.attachment.id, after),
        ),
      )
      .orderBy(asc(schema.attachment.id))
      .limit(PAGE);
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;

    const objects = rows.flatMap((row): ManifestObject[] => [
      { attachmentId: row.id, key: row.storageKey, kind: 'file' },
      ...(row.thumbnailKey
        ? [{ attachmentId: row.id, key: row.thumbnailKey, kind: 'thumbnail' as const }]
        : []),
    ]);
    yield Buffer.from(await manifestLines(source, objects, totals, copyTo), 'utf8');
  }

  // The uploaded instance logo lives in attachment storage too.
  const logo = (await getSetting('branding')).logoUrl ?? null;
  if (isManagedLogoKey(logo)) {
    const lines = await manifestLines(
      source,
      [{ attachmentId: null, key: logo!, kind: 'logo' }],
      totals,
      copyTo,
    );
    yield Buffer.from(lines, 'utf8');
  }
}
