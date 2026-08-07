import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from '../../lib/errors.js';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  insert: vi.fn(),
  getSetting: vi.fn().mockResolvedValue({ shareLinks: true }),
  getOwnedThread: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  db: { transaction: mocks.transaction, insert: mocks.insert },
}));
vi.mock('../../services/settings.js', () => ({ getSetting: mocks.getSetting }));
vi.mock('../../services/threads.js', () => ({ getOwnedThread: mocks.getOwnedThread }));

import { createShareLink, getPublicShare, listShareLinks } from '../../services/share-links.js';

function limitedQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

describe('integration with mocked DB: share ownership and expiry', () => {
  beforeEach(() => {
    mocks.transaction.mockReset();
    mocks.insert.mockReset();
    mocks.getOwnedThread.mockReset();
    mocks.getOwnedThread.mockResolvedValue({ id: 'thread-1', userId: 'owner-1' });
    mocks.getSetting.mockResolvedValue({ shareLinks: true });
  });

  it('fails closed when the caller does not own the shared thread', async () => {
    mocks.getOwnedThread.mockRejectedValue(notFound('Thread not found'));

    await expect(createShareLink('thread-1', 'intruder', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(listShareLinks('thread-1', 'intruder')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects an expiration that is not in the future before inserting', async () => {
    await expect(
      createShareLink('thread-1', 'owner-1', { expiresAt: new Date(Date.now() - 1) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns 410 and no messages for an expired public share', async () => {
    const tx = {
      select: vi.fn(() =>
        limitedQuery([
          {
            id: 'share-1',
            threadId: 'thread-1',
            title: 'Expired thread',
            upToMessageId: null,
            expiresAt: new Date(Date.now() - 60_000),
            revokedAt: null,
            createdAt: new Date(),
          },
        ]),
      ),
      update: vi.fn(),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(getPublicShare('A'.repeat(32))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 410,
      details: { reason: 'expired' },
    });
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('hides all links while public sharing is disabled', async () => {
    mocks.getSetting.mockResolvedValue({ shareLinks: false });

    await expect(getPublicShare('A'.repeat(32))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
