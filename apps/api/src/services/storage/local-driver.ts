import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { notFound } from '../../lib/errors.js';
import type { StorageDriver, StoredObject } from './driver.js';

/**
 * Filesystem driver. Every resolved path is checked to stay inside the root so
 * a crafted key cannot escape the storage directory.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(rootPath: string) {
    this.root = resolve(rootPath);
  }

  private resolveKey(key: string): string {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('Resolved storage path escapes the storage root');
    }
    return target;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<StoredObject> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveKey(key));
    } catch {
      throw notFound('Attachment file is missing from storage');
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  static async ensureRoot(rootPath: string): Promise<void> {
    await mkdir(resolve(rootPath), { recursive: true });
  }

  get rootPath(): string {
    return this.root;
  }

  /** Exposed for diagnostics; not used to build responses. */
  pathFor(key: string): string {
    return join(this.root, key);
  }
}
