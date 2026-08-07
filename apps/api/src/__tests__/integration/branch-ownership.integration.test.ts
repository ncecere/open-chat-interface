import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock('../../db/index.js', () => ({ db: { transaction: mocks.transaction } }));

import { branchFromUserMessage } from '../../services/threads.js';

function limitedQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

function orderedQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return chain;
}

describe('integration with mocked DB: immutable branch ownership', () => {
  beforeEach(() => {
    mocks.transaction.mockReset();
  });

  it('does not inspect or copy messages when the source thread is not owned', async () => {
    const tx = {
      select: vi.fn(() => limitedQuery([])),
      insert: vi.fn(),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      branchFromUserMessage('thread-owned-by-someone-else', 'intruder', {
        messageId: 'message-1',
        text: 'replacement',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('rejects a message ID that is not part of the owned source thread', async () => {
    const sourceThread = {
      id: 'thread-1',
      organizationId: 'organization-1',
      userId: 'owner-1',
    };
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(limitedQuery([sourceThread]))
        .mockReturnValueOnce(orderedQuery([])),
      insert: vi.fn(),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      branchFromUserMessage('thread-1', 'owner-1', {
        messageId: 'message-from-another-thread',
        text: 'replacement',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
