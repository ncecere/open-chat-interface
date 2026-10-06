import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'all' as 'web' | 'worker' | 'all',
  draining: false,
  execute: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  end: vi.fn(),
  workerStatus: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  db: { execute: mocks.execute },
}));
// LISTEN runs on a control connection of its own (v0.11, section 11).
vi.mock('../../db/control.js', () => ({
  openControlClient: () => ({ listen: mocks.listen, end: mocks.end }),
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
  assertManualRunPlaced,
  JOB_ACK_CHANNEL,
  JOB_REQUEST_CHANNEL,
  kickJob,
  listenForJobRequests,
  manualRunAck,
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
  mocks.end.mockReset().mockResolvedValue(undefined);
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
    // A worker answers the request as it takes it (#265).
    let answer!: (payload: string) => void;
    mocks.listen.mockImplementation(async (_channel: string, onNotify: (p: string) => void) => {
      answer = onNotify;
      return { unlisten: mocks.unlisten };
    });
    mocks.execute.mockImplementation(async () => {
      const [, request] = notified().at(-1)!;
      answer('another-request');
      answer(request.requestId);
      return [];
    });
    mocks.workerStatus.mockResolvedValueOnce({ alive: true });
    expect(await requestManualRun({ job: 'backups.run', actor })).toBe('queued');
    expect(mocks.listen).toHaveBeenCalledWith(JOB_ACK_CHANNEL, expect.any(Function));
    expect(notified()).toEqual([
      [JOB_REQUEST_CHANNEL, { job: 'backups.run', actor, requestId: expect.any(String) }],
    ]);
    // The ack listener and its connection are closed again.
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(manualRunConflict()).toMatchObject({ status: 409 });
  });

  it('reports a manual run no worker takes in time as not started (#265)', async () => {
    mocks.role = 'web';
    manualRunAck.timeoutMs = 50;
    mocks.listen.mockResolvedValue({ unlisten: mocks.unlisten });
    // A worker that has just stopped still looks alive.
    mocks.workerStatus.mockResolvedValue({ alive: true, evidence: 'job-runs' });
    expect(await requestManualRun({ job: 'reports.send-due' })).toBe('unanswered');
    expect(() => assertManualRunPlaced('unanswered')).toThrow(/has not started/);
    expect(assertManualRunPlaced('queued')).toBe('queued');
    // Nor can it be confirmed without LISTEN.
    mocks.listen.mockRejectedValueOnce(new Error('no control connection'));
    expect(await requestManualRun({ job: 'reports.send-due' })).toBe('unanswered');
    expect(mocks.end).toHaveBeenCalledTimes(2);
    manualRunAck.timeoutMs = 5_000;
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
    // The control connection is closed with it.
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('answers a manual run as it takes it, unless it cannot run it (#265)', async () => {
    const handle = vi.fn(async () => undefined);
    let deliver!: (payload: string) => void;
    mocks.listen.mockImplementation(async (_channel: string, onNotify: (p: string) => void) => {
      deliver = onNotify;
      return { unlisten: mocks.unlisten };
    });
    await listenForJobRequests(handle, (request) => request.job !== 'not.here');
    deliver(JSON.stringify({ job: 'reports.send-due', requestId: 'r-1' }));
    deliver(JSON.stringify({ job: 'not.here', requestId: 'r-2' }));
    // A kick is not a manual run: nothing to answer.
    deliver(JSON.stringify({ job: 'imports.process' }));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    expect(notified()).toEqual([['oci_job_request_acks', 'r-1']]);
    expect(handle).not.toHaveBeenCalledWith(expect.objectContaining({ job: 'not.here' }));
    // A draining worker neither answers nor runs it.
    mocks.draining = true;
    deliver(JSON.stringify({ job: 'reports.send-due', requestId: 'r-3' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notified()).toHaveLength(1);
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
    expect(mocks.end).toHaveBeenCalledOnce();
    await expect(stop()).resolves.toBeUndefined();
  });
});
