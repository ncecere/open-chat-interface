import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'all' as 'web' | 'worker' | 'all',
  draining: false,
  execute: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  workerStatus: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  db: { execute: mocks.execute },
  sql: { listen: mocks.listen },
}));
vi.mock('../../lib/role.js', () => ({
  runsBackgroundJobs: () => mocks.role !== 'web',
  processRole: () => mocks.role,
}));
vi.mock('../../lib/drain.js', () => ({ isDraining: () => mocks.draining }));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/jobs/workers.js', () => ({ workerStatus: mocks.workerStatus }));

import {
  JOB_REQUEST_CHANNEL,
  kickJob,
  listenForJobRequests,
  manualRunConflict,
  requestManualRun,
} from '../../services/jobs/requests.js';

/** The payload of each pg_notify sent. */
function notified() {
  return mocks.execute.mock.calls.map(([query]) => {
    const chunks = (query as { queryChunks: unknown[] }).queryChunks;
    const params = chunks.filter((chunk) => typeof chunk === 'string') as string[];
    return params.map((value) => (value.startsWith('{') ? JSON.parse(value) : value));
  });
}

beforeEach(() => {
  mocks.role = 'all';
  mocks.draining = false;
  mocks.execute.mockReset().mockResolvedValue([]);
  mocks.listen.mockReset();
  mocks.unlisten.mockReset().mockResolvedValue(undefined);
  mocks.workerStatus.mockReset();
  mocks.warn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('work a request starts (OCI_ROLE)', () => {
  it('runs it here on a replica that runs jobs', () => {
    const runHere = vi.fn();
    kickJob('imports.process', runHere);
    expect(runHere).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
    // Without a local runner, the tick does it.
    expect(() => kickJob('projects.embed-passages')).not.toThrow();
  });

  it('asks a worker on a web replica, once per burst', async () => {
    vi.useFakeTimers();
    mocks.role = 'web';
    const runHere = vi.fn();
    kickJob('webhooks.deliver', runHere);
    kickJob('webhooks.deliver', runHere);
    kickJob('imports.process', runHere);
    await vi.advanceTimersByTimeAsync(300);
    expect(runHere).not.toHaveBeenCalled();
    expect(notified()).toEqual([
      [JOB_REQUEST_CHANNEL, { job: 'webhooks.deliver' }],
      [JOB_REQUEST_CHANNEL, { job: 'imports.process' }],
    ]);
  });

  it('logs a notification that could not be sent; the tick still runs the job', async () => {
    vi.useFakeTimers();
    mocks.role = 'web';
    mocks.execute.mockRejectedValueOnce(new Error('connection lost'));
    kickJob('chat.compact-conversations');
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'chat.compact-conversations' }),
      expect.any(String),
    );
  });

  it('places a manual run here, on a worker, or nowhere', async () => {
    const actor = { id: 'admin-1', email: 'admin@oci.test' };
    expect(await requestManualRun({ job: 'backups.run', actor })).toBe('local');
    mocks.role = 'web';
    mocks.workerStatus.mockResolvedValueOnce({ alive: false });
    expect(await requestManualRun({ job: 'backups.run', actor })).toBe('no-worker');
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.workerStatus.mockResolvedValueOnce({ alive: true });
    expect(await requestManualRun({ job: 'backups.run', actor })).toBe('queued');
    expect(notified()).toEqual([[JOB_REQUEST_CHANNEL, { job: 'backups.run', actor }]]);
    expect(manualRunConflict()).toMatchObject({ status: 409 });
  });
});

describe('a worker listening for requests', () => {
  async function listening(handle: (request: never) => Promise<unknown>) {
    let deliver!: (payload: string) => void;
    mocks.listen.mockImplementation(async (_channel: string, onNotify: (p: string) => void) => {
      deliver = onNotify;
      return { unlisten: mocks.unlisten };
    });
    const stop = await listenForJobRequests(handle as never);
    expect(mocks.listen).toHaveBeenCalledWith(JOB_REQUEST_CHANNEL, expect.any(Function));
    return { deliver: (payload: unknown) => deliver(JSON.stringify(payload)), stop };
  }

  it('runs what was asked, once more if asked again while it ran, and actors separately', async () => {
    let finish!: () => void;
    const handle = vi.fn(async (request: { job: string; actor?: unknown }) => {
      if (request.job === 'imports.process' && handle.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const { deliver, stop } = await listening(handle);
    deliver({ job: 'imports.process' });
    deliver({ job: 'imports.process' });
    deliver({ job: 'imports.process' });
    const actor = { id: 'a', email: 'a@oci.test' };
    deliver({ job: 'backups.run', actor, extra: true });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    finish();
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(3));
    expect(handle.mock.calls.map(([request]) => request)).toEqual([
      { job: 'imports.process' },
      { job: 'backups.run', actor },
      { job: 'imports.process' },
    ]);
    await stop();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it('ignores malformed requests, and everything once draining', async () => {
    const handle = vi.fn(async () => undefined);
    const { deliver } = await listening(handle);
    deliver({ nope: true });
    deliver({ job: '' });
    deliver({ job: 'x', actor: { id: 1 } });
    deliver('not json {');
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    expect(handle).toHaveBeenCalledWith({ job: 'x' });
    mocks.draining = true;
    deliver({ job: 'y' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('logs a handler that fails, and keeps listening', async () => {
    const handle = vi.fn(async () => {
      throw new Error('boom');
    });
    const { deliver } = await listening(handle);
    deliver({ job: 'x' });
    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ job: 'x' }),
        'A requested job failed to start',
      ),
    );
  });

  it('carries on without listening where LISTEN is unavailable', async () => {
    mocks.listen.mockRejectedValueOnce(new Error('transaction pooler'));
    const stop = await listenForJobRequests(async () => undefined);
    expect(mocks.warn).toHaveBeenCalledOnce();
    await expect(stop()).resolves.toBeUndefined();
  });
});
