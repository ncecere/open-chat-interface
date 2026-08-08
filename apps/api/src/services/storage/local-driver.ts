import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { notFound } from '../../lib/errors.js';
import type { ListPage, StorageDriver, StoredObject } from './driver.js';

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

  /**
   * Walks the storage tree in sorted order so the cursor can simply be the
   * last key returned: the filesystem has no native pagination, and a stable
   * ordering is what makes resuming correct.
   */
  async list(options?: { cursor?: string; limit?: number }): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options?.limit ?? 1_000, 10_000));
    const collected: ListPage['objects'] = [];
    let truncated = false;

    const walk = async (directory: string): Promise<void> => {
      if (truncated) return;

      const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
      if (!entries) return;

      for (const entry of [...entries].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      )) {
        if (truncated) return;
        const absolute = join(directory, String(entry.name));

        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;

        const key = relative(this.root, absolute).split(sep).join('/');
        if (options?.cursor && key <= options.cursor) continue;

        if (collected.length >= limit) {
          truncated = true;
          return;
        }

        const info = await stat(absolute).catch(() => null);
        if (!info) continue;
        collected.push({ key, sizeBytes: info.size, lastModified: info.mtime });
      }
    };

    await walk(this.root);

    const last = collected.at(-1);
    return { objects: collected, ...(truncated && last ? { cursor: last.key } : {}) };
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
