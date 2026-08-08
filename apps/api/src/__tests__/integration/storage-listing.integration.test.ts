import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

let root: string;
let driver: LocalStorageDriver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oci-storage-list-'));
  driver = new LocalStorageDriver(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local storage listing', () => {
  it('enumerates objects across the per-user directories', async () => {
    await driver.put('user-1/a.png', Buffer.from('one'), 'image/png');
    await driver.put('user-1/b.png', Buffer.from('two'), 'image/png');
    await driver.put('user-2/c.png', Buffer.from('three'), 'image/png');

    const page = await driver.list();
    expect(page.objects.map((object) => object.key).sort()).toEqual([
      'user-1/a.png',
      'user-1/b.png',
      'user-2/c.png',
    ]);
    expect(page.cursor).toBeUndefined();
  });

  it('reports each object size so orphan cleanup can account for freed bytes', async () => {
    await driver.put('user-1/a.png', Buffer.alloc(1_234), 'image/png');

    const page = await driver.list();
    expect(page.objects[0]?.sizeBytes).toBe(1_234);
  });

  it('resumes from the cursor without repeating or skipping keys', async () => {
    for (let index = 0; index < 7; index += 1) {
      await driver.put(`user-1/file-${index}.txt`, Buffer.from(String(index)), 'text/plain');
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await driver.list({ cursor, limit: 3 });
      seen.push(...page.objects.map((object) => object.key));
      cursor = page.cursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('returns an empty page rather than failing on an empty root', async () => {
    const page = await driver.list();
    expect(page.objects).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('stops listing an object once it is deleted', async () => {
    await driver.put('user-1/a.png', Buffer.from('one'), 'image/png');
    await driver.delete('user-1/a.png');

    const page = await driver.list();
    expect(page.objects).toEqual([]);
  });
});
