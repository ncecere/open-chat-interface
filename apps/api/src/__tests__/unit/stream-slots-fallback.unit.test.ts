import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sharedRedis: vi.fn(),
  eval: vi.fn(),
  zrem: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../services/chat-streams.js', () => ({
  sharedRedis: mocks.sharedRedis,
  noteRedisFailure: () => undefined,
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getRateLimitSettings: async () => ({
    roles: { restricted: { maxConcurrentStreams: 1 } },
  }),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: mocks.warn } }));

import { acquireStreamSlot, resetLocalConcurrency } from '../../services/limits/concurrency.js';

beforeEach(() => {
  vi.resetAllMocks();
  resetLocalConcurrency();
});

describe('stream-slot availability and release contracts', () => {
  it('fails open and warns when atomic Redis acquisition fails', async () => {
    const error = new Error('Redis unavailable');
    mocks.sharedRedis.mockResolvedValue({ eval: mocks.eval, zrem: mocks.zrem });
    mocks.eval.mockRejectedValue(error);

    const slot = await acquireStreamSlot('user', 'restricted', 'run');
    expect(slot).not.toBeNull();
    expect(mocks.eval).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      { error, userId: 'user' },
      'Concurrency cap unavailable; allowing the run',
    );
    await expect(slot?.release()).resolves.toBeUndefined();
    await expect(slot?.release()).resolves.toBeUndefined();
    expect(mocks.zrem).not.toHaveBeenCalled();
  });

  it('does not fail open when Redis reports a full cap', async () => {
    mocks.sharedRedis.mockResolvedValue({ eval: mocks.eval, zrem: mocks.zrem });
    mocks.eval.mockResolvedValue(0);

    expect(await acquireStreamSlot('user', 'restricted', 'run')).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.zrem).not.toHaveBeenCalled();
  });

  it('keeps release best-effort when Redis becomes unavailable', async () => {
    mocks.sharedRedis.mockResolvedValue({ eval: mocks.eval, zrem: mocks.zrem });
    mocks.eval.mockResolvedValue(1);
    mocks.zrem.mockRejectedValue(new Error('Redis disconnected'));

    const slot = await acquireStreamSlot('user', 'restricted', 'run');
    expect(slot).not.toBeNull();
    await expect(slot?.release()).resolves.toBeUndefined();
    await expect(slot?.release()).resolves.toBeUndefined();
    expect(mocks.zrem).toHaveBeenCalledWith('oci:concurrency:user:user', 'run');
  });

  it('uses local slots without Redis, including same-run retries at the cap', async () => {
    mocks.sharedRedis.mockResolvedValue(null);
    const first = await acquireStreamSlot('user', 'restricted', 'run');
    expect(first).not.toBeNull();
    expect(await acquireStreamSlot('user', 'restricted', 'run')).not.toBeNull();
    expect(await acquireStreamSlot('user', 'restricted', 'blocked')).toBeNull();
    expect(await acquireStreamSlot('other-user', 'restricted', 'run')).not.toBeNull();

    await first?.release();
    await first?.release();
    expect(await acquireStreamSlot('user', 'restricted', 'replacement')).not.toBeNull();
    await first?.release();
    expect(await acquireStreamSlot('user', 'restricted', 'blocked')).toBeNull();
  });
});
