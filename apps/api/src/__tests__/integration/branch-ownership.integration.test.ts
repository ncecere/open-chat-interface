import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock('../../db/index.js', () => ({ db: { transaction: mocks.transaction } }));

import { branchFromUserMessage, forkFromMessage } from '../../services/threads.js';

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

  it.each([
    ['user', 'message-1'],
    ['assistant', 'message-2'],
  ] as const)('forks immutably through a selected %s message', async (_role, selectedId) => {
    const sourceThread = {
      id: 'thread-1',
      organizationId: 'organization-1',
      userId: 'owner-1',
      title: 'Original',
      temporary: false,
      expiresAt: null,
    };
    const sourceMessages = [
      {
        id: 'message-1',
        threadId: 'thread-1',
        userId: 'owner-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Question' }],
        position: 0,
        modelSlug: null,
        effort: null,
        webSearchUsed: false,
        status: 'complete',
        errorMessage: null,
        supersededAt: null,
        tokensIn: null,
        tokensOut: null,
        durationMs: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'message-2',
        threadId: 'thread-1',
        userId: 'owner-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Answer' }],
        position: 1,
        modelSlug: 'model-a',
        effort: 'high',
        webSearchUsed: true,
        status: 'complete',
        errorMessage: null,
        supersededAt: null,
        tokensIn: 4,
        tokensOut: 8,
        durationMs: 50,
        createdAt: new Date('2026-01-01T00:00:01Z'),
        updatedAt: new Date('2026-01-01T00:00:01Z'),
      },
      {
        id: 'message-3',
        threadId: 'thread-1',
        userId: 'owner-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Do not copy' }],
        position: 2,
        modelSlug: null,
        effort: null,
        webSearchUsed: false,
        status: 'complete',
        errorMessage: null,
        supersededAt: null,
        tokensIn: null,
        tokensOut: null,
        durationMs: null,
        createdAt: new Date('2026-01-01T00:00:02Z'),
        updatedAt: new Date('2026-01-01T00:00:02Z'),
      },
    ];
    const fork = { id: 'fork-1', parentThreadId: sourceThread.id };
    const inserted: unknown[] = [];
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(limitedQuery([sourceThread]))
        .mockReturnValueOnce(orderedQuery(sourceMessages))
        // The source has no compaction to copy.
        .mockReturnValueOnce(orderedQuery([])),
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn((value) => {
            inserted.push(value);
            return { returning: () => Promise.resolve([fork]) };
          }),
        })
        .mockReturnValueOnce({
          values: vi.fn((value: Array<{ parentMessageId: string }>) => {
            inserted.push(value);
            return {
              returning: () =>
                Promise.resolve(
                  value.map((row) => ({
                    id: `copy-${row.parentMessageId}`,
                    sourceId: row.parentMessageId,
                  })),
                ),
            };
          }),
        }),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      forkFromMessage('thread-1', 'owner-1', { messageId: selectedId }),
    ).resolves.toEqual(fork);

    const copied = inserted[1] as { parentMessageId: string; modelSlug: string | null }[];
    expect(copied).toHaveLength(selectedId === 'message-1' ? 1 : 2);
    expect(copied.map((message) => message.parentMessageId)).toEqual(
      selectedId === 'message-1' ? ['message-1'] : ['message-1', 'message-2'],
    );
    if (selectedId === 'message-2') expect(copied[1]?.modelSlug).toBe('model-a');
    expect(sourceMessages).toHaveLength(3);
    // Only the thread and its messages were written.
    expect(tx.insert).toHaveBeenCalledTimes(2);
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
