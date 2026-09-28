import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateReplayRun } from '../../services/chat-replay-validation.js';

describe('bounded durable replay validation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([true, false])('returns %s and clears its deadline', async (value) => {
    expect(await validateReplayRun(async () => value)).toBe(value);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves validation failures instead of treating them as missing state', async () => {
    const error = new Error('injected database failure');
    await expect(
      validateReplayRun(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out one stuck check, aborts its signal and ignores a late result', async () => {
    let scope: AbortSignal | undefined;
    let resolve!: (active: boolean) => void;
    const check = vi.fn((signal: AbortSignal) => {
      scope = signal;
      return new Promise<boolean>((done) => {
        resolve = done;
      });
    });
    const assertion = expect(validateReplayRun(check)).rejects.toThrow('validation timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(scope?.aborted).toBe(true);
    resolve(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts a pending check when its reader leaves', async () => {
    const reader = new AbortController();
    const reason = new Error('reader left');
    let scope: AbortSignal | undefined;
    const check = vi.fn((signal: AbortSignal) => {
      scope = signal;
      return new Promise<boolean>(() => {});
    });
    const assertion = expect(validateReplayRun(check, reader.signal)).rejects.toBe(reason);
    await Promise.resolve();
    reader.abort(reason);
    await assertion;
    expect(scope?.aborted).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not invoke a checker for a reader already aborted', async () => {
    const reader = new AbortController();
    reader.abort();
    const check = vi.fn(async () => true);
    await expect(validateReplayRun(check, reader.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
