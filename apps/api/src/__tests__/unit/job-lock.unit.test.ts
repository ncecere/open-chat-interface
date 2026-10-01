import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const owner = Object.assign(vi.fn(), { release: vi.fn() });
  return {
    owner,
    client: { reserve: vi.fn(), end: vi.fn() },
    createDatabase: vi.fn(),
    error: vi.fn(),
  };
});
vi.mock('@oci/db', () => ({ createDatabase: mocks.createDatabase }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ DATABASE_URL: 'postgres://test-only' }),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { error: mocks.error } }));

import { withJobLock } from '../../services/jobs/lock.js';

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
