import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the scheduling is under test: the lock runs the job at once, and the
// run record, metrics and tracing are inert.
vi.mock('../../services/jobs/lock.js', () => ({
  withJobLock: async (_name: string, run: (lease: unknown) => Promise<unknown>) =>
    run({ signal: new AbortController().signal, lost: false }),
}));
vi.mock('../../db/index.js', () => {
  const chain = {
    values: () => chain,
    returning: async () => [{ id: 'run' }],
    set: () => chain,
    where: async () => undefined,
  };
  return { db: { insert: () => chain, update: () => chain } };
});
vi.mock('../../lib/db-connection.js', () => ({
  retryOnConnectionError: (fn: () => unknown) => fn(),
}));
vi.mock('../../services/observability/events.js', () => ({ observeJob: () => undefined }));
vi.mock('../../services/observability/tracing.js', () => ({
  withSpan: (_name: string, _attrs: unknown, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: () => undefined }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
}));

const { startJobs, stopJobs } = await import('../../services/jobs/runner.js');

afterEach(() => {
  stopJobs();
  vi.useRealTimers();
});

describe('starting background jobs', () => {
  it('runs a run-on-start job a second in, not a whole interval later (#120)', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async () => 1);
    const sweep = vi.fn(async () => 1);
    startJobs([
      { name: 'webhooks.deliver', intervalMs: 60_000, runOnStart: true, run: deliver },
      { name: 'other', intervalMs: 60_000, run: sweep },
    ]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('cancels the first run when stopped before it', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async () => 1);
    startJobs([{ name: 'webhooks.deliver', intervalMs: 60_000, runOnStart: true, run: deliver }]);
    stopJobs();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).not.toHaveBeenCalled();
  });
});
