import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const owner = Object.assign(vi.fn(), { release: vi.fn() });
  return {
    owner,
    client: { reserve: vi.fn(), end: vi.fn() },
    createDatabase: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
});
vi.mock('@oci/db', () => ({ createDatabase: mocks.createDatabase }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ DATABASE_URL: 'postgres://test-only' }),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { error: mocks.error, warn: mocks.warn } }));

import { lockWatch, withJobLock } from '../../services/jobs/lock.js';

/** Answers the lock queries; `held` decides what the lease check sees. */
function answer(held: () => boolean | Promise<boolean> = () => true) {
  mocks.owner.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('pg_try_advisory_lock')) return [{ locked: true }];
    if (text.includes('pg_locks')) return [{ held: await held() }];
    return [{ unlocked: true }];
  });
}
const lockCalls = (fragment: string) =>
  mocks.owner.mock.calls.filter((call) => (call[0] as string[]).join('').includes(fragment));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createDatabase.mockReturnValue({ sql: mocks.client });
  mocks.client.reserve.mockResolvedValue(mocks.owner);
  mocks.client.end.mockResolvedValue(undefined);
  mocks.owner.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('pg_try_advisory_lock') ? [{ locked: true }] : [{ unlocked: true }],
  );
});
afterEach(() => {
  vi.useRealTimers();
});

describe('job lock connection lifecycle', () => {
  it('uses the reserved owner for acquire/unlock and always disposes the private client', async () => {
    expect(await withJobLock('cleanup', async () => 7)).toBe(7);
    expect(mocks.createDatabase).toHaveBeenCalledWith('postgres://test-only', { max: 1 });
    expect(mocks.client.reserve).toHaveBeenCalledOnce();
    expect(mocks.owner).toHaveBeenCalledTimes(2);
    for (const call of mocks.owner.mock.calls) expect(call[1]).toBe('oci:job:cleanup');
    expect(mocks.owner.release).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(mocks.owner.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.owner.release.mock.invocationCallOrder[0]!,
    );
    expect(mocks.owner.release.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.client.end.mock.invocationCallOrder[0]!,
    );
  });

  it('skips a contended lock without invoking work or unlocking another owner', async () => {
    mocks.owner.mockResolvedValueOnce([{ locked: false }]);
    const work = vi.fn();
    expect(await withJobLock('cleanup', work)).toBeNull();
    expect(work).not.toHaveBeenCalled();
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.owner.release).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('disposes a failed acquisition, including an ambiguous server-side result', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('Lost acquisition response'));
    const work = vi.fn();
    await expect(withJobLock('cleanup', work)).rejects.toThrow('Lost acquisition response');
    expect(work).not.toHaveBeenCalled();
    expect(mocks.owner.release).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });

  it('closes the private client when reserving fails', async () => {
    mocks.client.reserve.mockRejectedValueOnce(new Error('Reserve failed'));
    await expect(withJobLock('cleanup', async () => 1)).rejects.toThrow('Reserve failed');
    expect(mocks.owner.release).not.toHaveBeenCalled();
    expect(mocks.client.end).toHaveBeenCalledOnce();
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });

  it('does not leave a local claim behind when client construction fails', async () => {
    mocks.createDatabase.mockImplementationOnce(() => {
      throw new Error('Invalid configuration');
    });
    await expect(withJobLock('cleanup', async () => 1)).rejects.toThrow('Invalid configuration');
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });

  it('cleans up after work throws without replacing its error', async () => {
    const error = new Error('Insert or body failure');
    await expect(
      withJobLock('cleanup', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(mocks.owner).toHaveBeenCalledTimes(2);
    expect(mocks.owner.release).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it.each(['reject', 'false'])('discards the session after unlock returns %s', async (failure) => {
    mocks.owner.mockResolvedValueOnce([{ locked: true }]);
    if (failure === 'reject') mocks.owner.mockRejectedValueOnce(new Error('Unlock rejected'));
    else mocks.owner.mockResolvedValueOnce([{ unlocked: false }]);
    expect(await withJobLock('cleanup', async () => 5)).toBe(5);
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
    expect(await withJobLock('cleanup', async () => 6)).toBe(6);
    expect(mocks.createDatabase).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung unlock and still disposes the client', async () => {
    vi.useFakeTimers();
    mocks.owner.mockResolvedValueOnce([{ locked: true }]);
    mocks.owner.mockReturnValueOnce(new Promise(() => {}));
    const result = withJobLock('cleanup', async () => 5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe(5);
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.owner.release).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still disposes the client if releasing its reservation throws', async () => {
    mocks.owner.release.mockImplementationOnce(() => {
      throw new Error('Release failed');
    });
    await expect(withJobLock('cleanup', async () => 1)).rejects.toThrow('Release failed');
    expect(mocks.client.end).toHaveBeenCalledOnce();
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });

  it('clears the local claim even if disposing the client rejects', async () => {
    mocks.client.end.mockRejectedValueOnce(new Error('Close failed'));
    await expect(withJobLock('cleanup', async () => 1)).rejects.toThrow('Close failed');
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });

  it('skips duplicate local ticks while work runs, without opening extra clients', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = withJobLock('cleanup', async () => {
      await gate;
      return 1;
    });
    try {
      const duplicate = vi.fn();
      expect(await withJobLock('cleanup', duplicate)).toBeNull();
      expect(duplicate).not.toHaveBeenCalled();
      expect(mocks.createDatabase).toHaveBeenCalledOnce();
    } finally {
      finish();
      await first;
    }
    expect(await withJobLock('cleanup', async () => 2)).toBe(2);
  });
});

describe('job lock lease (v0.11 failover safety)', () => {
  it('reports the lock held while its connection holds it, and releases it afterwards', async () => {
    answer();
    const result = await withJobLock('cleanup', async (lease) => {
      expect(lease.lost).toBe(false);
      expect(await lease.stillHeld()).toBe(true);
      expect(lease.signal.aborted).toBe(false);
      return 3;
    });
    expect(result).toBe(3);
    expect(lockCalls('pg_locks')).toHaveLength(1);
    expect(lockCalls('pg_advisory_unlock')).toHaveLength(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('treats a dead lock connection as a lost lock, and releases nothing', async () => {
    answer(() => {
      throw Object.assign(new Error('terminating connection due to administrator command'), {
        code: '57P01',
      });
    });
    const result = await withJobLock('cleanup', async (lease) => {
      expect(await lease.stillHeld()).toBe(false);
      expect(lease.lost).toBe(true);
      expect(lease.signal.aborted).toBe(true);
      // Once lost, it stays lost without asking again.
      expect(await lease.stillHeld()).toBe(false);
      return 1;
    });
    expect(result).toBe(1);
    expect(lockCalls('pg_locks')).toHaveLength(1);
    expect(lockCalls('pg_advisory_unlock')).toHaveLength(0);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('treats a connection that no longer holds the lock as lost', async () => {
    answer(() => false);
    await withJobLock('cleanup', async (lease) => {
      expect(await lease.stillHeld()).toBe(false);
      return 0;
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'The job lock is no longer held by its connection' }),
      expect.any(String),
    );
    expect(lockCalls('pg_advisory_unlock')).toHaveLength(0);
  });

  it('runs one check at a time, and bounds a hung one', async () => {
    vi.useFakeTimers();
    answer(() => new Promise<boolean>(() => {}));
    const result = withJobLock('cleanup', async (lease) => {
      const first = lease.stillHeld();
      const second = lease.stillHeld();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toBe(false);
      expect(await second).toBe(false);
      return 2;
    });
    expect(await result).toBe(2);
    expect(lockCalls('pg_locks')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks in the background while the job runs, so a job that never asks still learns', async () => {
    vi.useFakeTimers();
    const saved = lockWatch.intervalMs;
    lockWatch.intervalMs = 100;
    let alive = true;
    answer(() => alive);
    try {
      const result = withJobLock('cleanup', async (lease) => {
        await vi.advanceTimersByTimeAsync(100);
        expect(lease.lost).toBe(false);
        alive = false;
        await vi.advanceTimersByTimeAsync(100);
        expect(lease.lost).toBe(true);
        return 4;
      });
      expect(await result).toBe(4);
    } finally {
      lockWatch.intervalMs = saved;
    }
    expect(lockCalls('pg_locks').length).toBeGreaterThanOrEqual(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
