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

import {
  assertShareLinkManagementAllowed,
  createShareLink,
  getPublicShare,
  listShareLinks,
} from '../../services/share-links.js';

function limitedQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) }),
    orderBy: () => Promise.resolve(rows),
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
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        select: () => limitedQuery([]),
        insert: mocks.insert,
      }),
    );

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

  it('permits management only for unrestricted users with sharing enabled', async () => {
    await expect(assertShareLinkManagementAllowed('restricted')).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertShareLinkManagementAllowed('user')).resolves.toBeUndefined();
    mocks.getSetting.mockResolvedValue({ shareLinks: false });
    await expect(assertShareLinkManagementAllowed('admin')).rejects.toMatchObject({
      status: 422,
    });
  });

  it.each([false, true])('rejects unavailable public links (revoked: %s)', async (revoked) => {
    const tx = {
      select: vi.fn(() => limitedQuery(revoked ? [{ revokedAt: new Date() }] : [])),
      update: vi.fn(),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    await expect(getPublicShare('A'.repeat(32))).rejects.toMatchObject({
      status: revoked ? 410 : 404,
    });
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([false, true])('sanitizes a successful public share (snapshot: %s)', async (snapshot) => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = snapshot ? new Date(Date.now() + 60_000) : null;
    const select = vi.fn().mockReturnValueOnce(
      limitedQuery([
        {
          id: 'share-1',
          threadId: 'thread-1',
          title: 'password=private',
          upToMessageId: snapshot ? 'message-1' : null,
          expiresAt,
          revokedAt: null,
          createdAt,
        },
      ]),
    );
    if (snapshot) select.mockReturnValueOnce(limitedQuery([{ position: 1 }]));
    select.mockReturnValueOnce(
      limitedQuery([
        {
          id: 'message-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Public answer' },
            { type: 'reasoning', text: 'Private reasoning' },
          ],
          supersededAt: null,
          createdAt,
        },
      ]),
    );
    // The shared reply created no artifacts.
    select.mockReturnValueOnce(limitedQuery([]));
    const returning = vi.fn().mockResolvedValue([{ available: true }]);
    const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
    mocks.transaction.mockImplementation(async (callback) => callback({ select, update }));

    await expect(getPublicShare('A'.repeat(32))).resolves.toEqual({
      thread: { title: 'password=[REDACTED]', sharedAt: createdAt.toISOString() },
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Public answer' }],
          createdAt: createdAt.toISOString(),
        },
      ],
      artifacts: [],
      snapshot,
      expiresAt: expiresAt?.toISOString() ?? null,
    });
    expect(select).toHaveBeenCalledTimes(snapshot ? 4 : 3);
    expect(returning).toHaveBeenCalledOnce();
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
