// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { formatReadOnlyTime } from '../../src/lib/read-only';
import { cleanup, renderAdmin } from './admin-test-utils';

/**
 * The Email delivery row on System health gives its times in the reader's
 * local time, like every other time in administration (#345). The API wrote
 * "most recently at 2026-10-06 20:38 UTC" as one string, which the page could
 * not turn into local time (4:38 PM in New York). It now writes ISO 8601
 * instants, which the page already localises for the Read-only row; the exact
 * instant stays in the row's tooltip.
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

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it('shows email delivery times in local time, with the instant as the tooltip', async () => {
  const failedAt = '2026-10-06T20:38:11.482Z';
  const deliveredAt = '2026-10-06T21:02:40.100Z';
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/health')
      return {
        status: 'warn',
        checks: [
          {
            id: 'email',
            label: 'Email delivery',
            status: 'warn',
            detail: `The latest email through mailpit failed, most recently at ${failedAt}: connect ECONNREFUSED 172.29.0.2:1026. Until email works, people cannot verify their address or reset their password.`,
          },
          {
            id: 'email-ok',
            label: 'Email recovered',
            status: 'ok',
            detail: `Sending through mailpit; last delivered ${deliveredAt}`,
          },
          { id: 'jobs', label: 'Background jobs', status: 'ok', detail: 'No recent failures' },
        ],
      };
    if (path === '/admin/lifecycle/jobs') return { jobs: [] };
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
  const { AdminHealthPage } = await import('../../src/routes/admin/health');
  ({ root } = await renderAdmin(<AdminHealthPage />, { path: '/admin/health' }));

  const row = (label: string) =>
    [...document.querySelectorAll('li')]
      .find((item) => item.querySelector('p')?.textContent === label)!
      .querySelectorAll('p')[1]!;

  const failing = row('Email delivery');
  expect(failing.textContent).toBe(
    `The latest email through mailpit failed, most recently at ${formatReadOnlyTime(failedAt)}: connect ECONNREFUSED 172.29.0.2:1026. Until email works, people cannot verify their address or reset their password.`,
  );
  // No ISO instant in the text. (Not "no UTC": a machine whose own zone is UTC,
  // CI's, writes its local time as "UTC".)
  expect(failing.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  // The precise instant stays available.
  expect(failing.title).toContain(failedAt);

  const healthy = row('Email recovered');
  expect(healthy.textContent).toBe(
    `Sending through mailpit; last delivered ${formatReadOnlyTime(deliveredAt)}`,
  );
  expect(healthy.title).toContain(deliveredAt);

  // A row with no time has no tooltip.
  expect(row('Background jobs').title).toBe('');
});
