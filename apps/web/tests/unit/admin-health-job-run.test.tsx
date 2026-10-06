// @vitest-environment happy-dom
import type { BackgroundJob } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, click, renderAdmin } from './admin-test-utils';

/**
 * Background jobs after Run (#282), on the real System health page with the
 * real query client and its timers; only the API answers are stand-ins. Run
 * returns once a worker takes the request (#265), so the list read straight
 * after it shows the run starting. The job finished in 20 ms, but its row kept
 * the "Running" warning until the next read, 30 seconds later.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const JOB = 'storage.recompute-usage';
let runStatus: 'success' | 'running';
let startedAt: string;
let root: Root | undefined;

function jobs(): { jobs: BackgroundJob[] } {
  return {
    jobs: [
      {
        name: JOB,
        intervalMs: 86_400_000,
        lastRun: {
          id: 'run',
          jobName: JOB,
          status: runStatus,
          startedAt,
          finishedAt: runStatus === 'running' ? null : startedAt,
          durationMs: runStatus === 'running' ? null : 20,
          itemsProcessed: runStatus === 'running' ? 0 : 6,
          errorMessage: null,
        },
      } as BackgroundJob,
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runStatus = 'success';
  startedAt = new Date(Date.now() - 3_600_000).toISOString();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/health')
      return {
        status: 'ok',
        checks: [],
        observability: { metrics: true, tracing: false, tracingEndpoint: null },
      };
    if (path === '/admin/lifecycle/jobs') return jobs();
    if (path === '/admin/lifecycle/storage-health')
      return {
        liveBytes: 0,
        liveFileCount: 0,
        pendingBytes: 0,
        pendingFileCount: 0,
        pendingDeletions: 0,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockImplementation(async () => {
    // The worker has taken the request and started the run.
    runStatus = 'running';
    startedAt = new Date().toISOString();
    return { ok: true, skipped: false, queued: true, itemsProcessed: 0 };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.useRealTimers();
});

const icon = () =>
  document
    .querySelector(`li:has([aria-label="Run ${JOB} now"]) [role="img"]`)
    ?.getAttribute('aria-label');

it('shows a run that finished moments after Run as succeeded, within seconds', async () => {
  const { AdminHealthPage } = await import('../../src/routes/admin/health');
  ({ root } = await renderAdmin(<AdminHealthPage />, { path: '/admin/health' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(icon()).toBe('Succeeded');

  const run = document.querySelector<HTMLButtonElement>(`[aria-label="Run ${JOB} now"]`)!;
  await click(run);
  expect(api.post).toHaveBeenCalledWith(`/admin/lifecycle/jobs/${JOB}/run`);
  expect(icon()).toBe('Running');

  // It finishes 20 ms later; the row says so within a few seconds.
  runStatus = 'success';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(icon()).toBe('Succeeded');
});
