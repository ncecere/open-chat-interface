import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readObject } from './files.js';
import { captureTail, exitCode, pgConnectionFromUrl, pgToolPath, scrubSecret } from './pg-tools.js';
import type { BackupTarget } from './settings.js';

export const sha256 = () => createHash('sha256');

/** Where a step failed, kept short and free of secrets for the run history. */
export class BackupError extends Error {}

/** Wraps a source so its bytes are counted and hashed as they pass. */
export async function* measured(
  source: AsyncIterable<Uint8Array>,
  totals: { bytes: number; hash: ReturnType<typeof sha256> },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    totals.bytes += chunk.byteLength;
    totals.hash.update(chunk);
    yield chunk;
  }
}

/**
 * Streams `pg_dump --format=custom` into the target. The upload completes only
 * if pg_dump exits successfully: a failed dump throws from the source, which
 * aborts the multipart upload instead of storing a truncated archive.
 */
export async function dumpDatabase(
  target: BackupTarget,
  key: string,
  databaseUrl: string,
): Promise<{ bytes: number; sha256: string }> {
  const connection = await pgConnectionFromUrl(databaseUrl);
  const totals = { bytes: 0, hash: sha256() };
  try {
    const child = spawn(pgToolPath('pg_dump'), ['--format=custom', '--no-password'], {
      env: connection.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = captureTail(child);
    const exited = exitCode(child);
    exited.catch(() => undefined);

    async function* output(): AsyncGenerator<Uint8Array> {
      if (child.stdout) yield* child.stdout as AsyncIterable<Uint8Array>;
      let code: number;
      try {
        code = await exited;
      } catch (error) {
        throw new BackupError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'pg_dump was not found. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.'
            : 'pg_dump could not be started.',
        );
      }
      if (code !== 0)
        throw new BackupError(
          `pg_dump failed (exit ${code}): ${scrubSecret(stderr(), connection.password).slice(-500) || 'no output'}`,
        );
    }

    try {
      await target.driver.putStream(key, measured(output(), totals), 'application/octet-stream');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    return { bytes: totals.bytes, sha256: totals.hash.digest('hex') };
  } finally {
    await connection.cleanup();
  }
}

/**
 * Reads the stored archive back: its size and SHA-256 must match what was
 * written, and `pg_restore --list` must read its table of contents.
 */
export async function verifyDump(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string },
): Promise<string> {
  const child = spawn(pgToolPath('pg_restore'), ['--list'], {
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = captureTail(child);
  const exited = exitCode(child);
  exited.catch(() => undefined);
  let listing = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (listing.length < 20 * 1024 * 1024) listing += chunk;
  });
  // pg_restore stops reading once it has the table of contents; the rest is
  // still read here for the checksum, and writes to the closed pipe are dropped.
  let stdinOpen = true;
  child.stdin?.on('error', () => {
    stdinOpen = false;
  });
  child.stdin?.on('close', () => {
    stdinOpen = false;
  });

  const hash = sha256();
  let bytes = 0;
  try {
    for await (const chunk of await readObject(target.driver, key)) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (stdinOpen && child.stdin && !child.stdin.write(chunk) && stdinOpen) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          child.stdin?.once('drain', done);
          child.stdin?.once('close', done);
          child.stdin?.once('error', done);
        });
      }
    }
  } finally {
    child.stdin?.end();
  }

  let code: number;
  try {
    code = await exited;
  } catch {
    throw new BackupError(
      'pg_restore was not found. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.',
    );
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw new BackupError(
      'Verification failed: the stored archive does not match what was written.',
    );
  if (code !== 0)
    throw new BackupError(
      `Verification failed: pg_restore could not read the archive (${stderr().slice(-300) || `exit ${code}`}).`,
    );

  const entries = listing.split('\n').filter((line) => line.trim() && !line.startsWith(';'));
  const tables = entries.filter((line) => / TABLE (?!DATA)/.test(line)).length;
  if (entries.length === 0 || tables === 0)
    throw new BackupError('Verification failed: the archive lists no tables.');
  return `${entries.length} archive entries, ${tables} tables`;
}

/** Reads the manifest back and checks its checksum and line count. */
export async function verifyManifest(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string; lines: number },
): Promise<void> {
  const hash = sha256();
  let bytes = 0;
  let lines = 0;
  for await (const chunk of await readObject(target.driver, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 0x0a) lines += 1;
  }
  if (
    bytes !== expected.bytes ||
    hash.digest('hex') !== expected.sha256 ||
    lines !== expected.lines
  )
    throw new BackupError('Verification failed: the stored attachment manifest does not match.');
}
