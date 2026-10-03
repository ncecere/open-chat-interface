import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChecksumMismatchError,
  eachLimit,
  readManifestLines,
  verifiedStream,
} from '../../services/backups/files.js';
import { runRestoreFilesCli } from '../../services/backups/restore-files.js';
import type { StorageDriver } from '../../services/storage/driver.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

/** A driver that serves one object in the given chunks. */
function chunked(chunks: Buffer[]): StorageDriver {
  return {
    name: 's3',
    put: async () => ({ key: '', sizeBytes: 0 }),
    get: async () => Buffer.concat(chunks),
    delete: async () => undefined,
    exists: async () => true,
    list: async () => ({ objects: [] }),
    getStream: async () => Readable.from(chunks),
  };
}

describe('backup files', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it('reads a manifest a line at a time across chunk and character boundaries', async () => {
    const text = Buffer.from(
      `${JSON.stringify({ key: 'a/é.bin', kind: 'file', sha256: 'x' })}\n\n${JSON.stringify({ key: 'b', kind: 'file', missing: true })}`,
      'utf8',
    );
    // Split inside the two-byte é and inside the blank line.
    const split = text.indexOf(Buffer.from('é')) + 1;
    const lines = await collect(
      readManifestLines(
        chunked([
          text.subarray(0, split),
          text.subarray(split, split + 30),
          text.subarray(split + 30),
        ]),
        'attachments.jsonl',
      ),
    );
    expect(lines).toEqual([
      { key: 'a/é.bin', kind: 'file', sha256: 'x' },
      { key: 'b', kind: 'file', missing: true },
    ]);
  });

  it('passes matching bytes through and refuses bytes that do not match', async () => {
    const body = Buffer.from('hello backup');
    const expected = { sha256: sha(body), bytes: body.byteLength, key: 'k' };
    const passed = await collect(verifiedStream(Readable.from([body]), expected));
    expect(Buffer.concat(passed).equals(body)).toBe(true);
    await expect(
      collect(verifiedStream(Readable.from([Buffer.from('changed')]), expected)),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    await expect(
      collect(verifiedStream(Readable.from([body, Buffer.from('!')]), expected)),
    ).rejects.toThrow(/do not match/);
  });

  it('runs tasks with bounded concurrency', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      done.push(item);
      running -= 1;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await eachLimit([], 4, async () => {
      throw new Error('never called');
    });
  });

  it('writes a local stream into place, and leaves nothing when the source fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oci-local-stream-'));
    directories.push(root);
    const driver = new LocalStorageDriver(root);
    const body = Buffer.from('streamed content');
    expect(await driver.putStream('u/a.bin', Readable.from([body]), 'text/plain')).toEqual({
      key: 'u/a.bin',
      sizeBytes: body.byteLength,
    });
    expect((await driver.get('u/a.bin')).equals(body)).toBe(true);

    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('source failed');
    }
    await expect(driver.putStream('u/b.bin', broken(), 'text/plain')).rejects.toThrow(
      'source failed',
    );
    expect(await readdir(join(root, 'u'))).toEqual(['a.bin']);
    await expect(driver.putStream('../escape', Readable.from([body]), 'x')).rejects.toThrow(
      /escapes/,
    );
  });

  it('explains how to run the restore script when the arguments are wrong', async () => {
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const output: string[] = [];
      const code = await runRestoreFilesCli(args, env, (line) => output.push(line));
      return { code, output: output.join('\n') };
    };
    expect(await run(['--help'])).toMatchObject({
      code: 0,
      output: expect.stringMatching(/^Usage/),
    });
    // Exactly one target.
    expect((await run(['folder/'])).code).toBe(2);
    expect((await run(['folder/', '--to-local', '/tmp/x', '--to-s3'])).code).toBe(2);
    expect(await run(['folder/', '--to-local', '/tmp/x', '--concurrency', '0'])).toMatchObject({
      code: 2,
      output: '--concurrency must be a positive whole number.',
    });
    expect(await run(['folder/', '--to-s3'], { BACKUP_S3_BUCKET: 'b' })).toMatchObject({
      code: 2,
      output: 'Set BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY.',
    });
    const backup = {
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'id',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    };
    expect(await run(['folder/', '--to-s3'], backup)).toMatchObject({
      code: 2,
      output: 'Set TARGET_S3_BUCKET, TARGET_S3_ACCESS_KEY_ID, TARGET_S3_SECRET_ACCESS_KEY.',
    });
    expect(await run(['--unknown'])).toMatchObject({ code: 2 });
  });
});
