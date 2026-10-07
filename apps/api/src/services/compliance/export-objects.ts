import { createHash } from 'node:crypto';
import type { BackupTarget } from '../backups/settings.js';

/** A failure explained in words fit for the run history. */
export class ComplianceExportError extends Error {}

async function readObject(target: BackupTarget, key: string): Promise<AsyncIterable<Uint8Array>> {
  return (await target.driver.getStream(key)) as AsyncIterable<Uint8Array>;
}

/** Reads an object back: its size, SHA-256 and line count must be what was written. */
export async function verifyObject(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string; lines: number | null },
): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  for await (const chunk of await readObject(target, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 0x0a) lines += 1;
  }
  if (
    bytes !== expected.bytes ||
    hash.digest('hex') !== expected.sha256 ||
    (expected.lines !== null && lines !== expected.lines)
  )
    throw new ComplianceExportError(
      `Verification failed: the stored ${key.split('/').at(-1)} does not match what was written.`,
    );
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

/** `<prefix>YYYY/MM/DD/<start time>-<run id>/`: one folder per run, sorted by time. */
export function runFolder(root: string, startedAt: Date, runId: string): string {
  const day = startedAt.toISOString().slice(0, 10).replace(/-/g, '/');
  return `${root}${day}/${stamp(startedAt)}-${runId.slice(0, 8)}/`;
}
