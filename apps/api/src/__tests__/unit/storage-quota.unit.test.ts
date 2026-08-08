import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getDefaultOrganizationId: vi.fn().mockResolvedValue('organization-1'),
  getSetting: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ db: { select: mocks.select } }));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: mocks.getDefaultOrganizationId,
}));
vi.mock('../../services/settings.js', () => ({ getSetting: mocks.getSetting }));

import { assertStorageAllowance, getStorageUsage } from '../../services/storage/quota.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Mirrors select().from().where().limit() for both lookups. */
function tableQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
  };
  return chain;
}

/** Storage usage is read first, then the role's policy. */
function respondWith(usage: unknown[], policy: unknown[]) {
  const queue = [usage, policy];
  mocks.select.mockImplementation(() => tableQuery(queue.shift() ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockResolvedValue({ maxFileBytes: 20 * MB });
});

describe('storage allowance', () => {
  it('leaves a role with no policy unlimited', async () => {
    respondWith([{ liveBytes: 500 * MB, liveFileCount: 40 }], []);

    await expect(
      assertStorageAllowance({
        userId: 'user-1',
        role: 'user',
        incomingBytes: 5 * MB,
        incomingFiles: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an upload that would cross the total byte allowance', async () => {
    respondWith(
      [{ liveBytes: GB - 2 * MB, liveFileCount: 10 }],
      [{ role: 'user', maxTotalBytes: GB, maxFileCount: null, maxFileBytes: null, enabled: true }],
    );

    await expect(
      assertStorageAllowance({
        userId: 'user-1',
        role: 'user',
        incomingBytes: 5 * MB,
        incomingFiles: 1,
      }),
    ).rejects.toThrow(/storage limit/i);
  });

  it('names the free space so the message is actionable', async () => {
    respondWith(
      [{ liveBytes: GB - 3 * MB, liveFileCount: 10 }],
      [{ role: 'user', maxTotalBytes: GB, maxFileCount: null, maxFileBytes: null, enabled: true }],
    );

    await expect(
      assertStorageAllowance({
        userId: 'user-1',
        role: 'user',
        incomingBytes: 10 * MB,
        incomingFiles: 1,
      }),
    ).rejects.toThrow(/3\.0 MB free/);
  });

  it('enforces the stored-file count independently of bytes', async () => {
    respondWith(
      [{ liveBytes: 1 * MB, liveFileCount: 100 }],
      [{ role: 'user', maxTotalBytes: null, maxFileCount: 100, maxFileBytes: null, enabled: true }],
    );

    await expect(
      assertStorageAllowance({
        userId: 'user-1',
        role: 'user',
        incomingBytes: 1024,
        incomingFiles: 1,
      }),
    ).rejects.toThrow(/stored files/i);
  });

  it('lets a role tighten the per-file cap but never loosen it', async () => {
    respondWith(
      [{ liveBytes: 0, liveFileCount: 0 }],
      [
        {
          role: 'user',
          maxTotalBytes: null,
          maxFileCount: null,
          // Larger than the instance setting, so the instance wins.
          maxFileBytes: 500 * MB,
          enabled: true,
        },
      ],
    );

    const usage = await getStorageUsage('user-1', 'user');
    expect(usage.maxFileBytes).toBe(20 * MB);
  });

  it('excludes soft-deleted bytes from the allowance', async () => {
    respondWith(
      [{ liveBytes: 10 * MB, liveFileCount: 2, pendingBytes: 900 * MB, pendingFileCount: 50 }],
      [{ role: 'user', maxTotalBytes: GB, maxFileCount: null, maxFileBytes: null, enabled: true }],
    );

    // 910 MB is on disk, but only the 10 MB live counts, so this fits inside
    // the 1 GB allowance: deleting files frees space at once, not after the
    // trash window elapses.
    await expect(
      assertStorageAllowance({
        userId: 'user-1',
        role: 'user',
        incomingBytes: 15 * MB,
        incomingFiles: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
