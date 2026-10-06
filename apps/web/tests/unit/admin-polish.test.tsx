// @vitest-environment happy-dom
import type { BackgroundJob } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStatusIcon } from '../../src/components/admin/operations/runs';
import { formatReadOnlyTime, readOnlyMessage } from '../../src/lib/read-only';
import { formatDateTime } from '../../src/lib/utils';
import { AdminHealthPage } from '../../src/routes/admin/health';
import { AdminOverviewPage } from '../../src/routes/admin/overview';
import { cleanup, renderAdmin } from './admin-test-utils';

/**
 * Admin polish (#305), on the real pages and helpers: one time format, one
 * word for conversations, and a neutral icon for a job that is running.
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
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('read-only times', () => {
  it('write the hour as the admin lists do: "7:30", not "07:30"', () => {
    const now = new Date(2026, 9, 6, 6, 0);
    const until = new Date(2026, 9, 6, 7, 30);
    // The admin lists' time of day, "Oct 6, 2026, 7:30 AM" → "7:30 AM".
    const listTime = formatDateTime(until).split(', ').at(-1)!;
    expect(listTime).toMatch(/^7:30/);
    const shown = formatReadOnlyTime(until.toISOString(), now);
    expect(shown.startsWith(listTime)).toBe(true);
    expect(shown).not.toContain('07:30');
    expect(
      readOnlyMessage(
        {
          active: true,
          source: 'administrator',
          reason: null,
          until: until.toISOString(),
          window: null,
        },
        now,
      ),
    ).toContain(`until about ${listTime}`);
  });

  it('keep the shared hour style on another day too', () => {
    const now = new Date(2026, 9, 6, 6, 0);
    const shown = formatReadOnlyTime(new Date(2026, 9, 8, 9, 5).toISOString(), now);
    expect(shown).toMatch(/\b9:05\b/);
    expect(shown).not.toContain('09:05');
  });
});

describe('a running job', () => {
  const classes = (element: Element | null | undefined) =>
    element?.getAttribute('class')?.split(/\s+/) ?? [];

  it('is not shown with the warning triangle on Backups and Compliance', async () => {
    ({ root } = await renderAdmin(<RunStatusIcon status="running" />));
    const icon = document.querySelector('[role="img"][aria-label="Running"]');
    expect(icon).not.toBeNull();
    expect(classes(icon)).not.toContain('lucide-triangle-alert');
    expect(classes(icon)).not.toContain('text-[var(--warning)]');
    expect(classes(icon)).toContain('lucide-loader-circle');
  });

  it('is not shown with the warning triangle on Health › Background jobs', async () => {
    const startedAt = new Date().toISOString();
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/health')
        return {
          status: 'ok',
          checks: [],
          observability: { metrics: true, tracing: false, tracingEndpoint: null },
        };
      if (path === '/admin/lifecycle/jobs')
        return {
          jobs: [
            {
              name: 'storage.recompute-usage',
              intervalMs: 86_400_000,
              lastRun: {
                id: 'run',
                jobName: 'storage.recompute-usage',
                status: 'running',
                startedAt,
                finishedAt: null,
                durationMs: null,
                itemsProcessed: 0,
                errorMessage: null,
              },
            } as BackgroundJob,
          ],
        };
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
    ({ root } = await renderAdmin(<AdminHealthPage />, { path: '/admin/health' }));
    const icon = document.querySelector('li [role="img"][aria-label="Running"]');
    expect(icon).not.toBeNull();
    expect(classes(icon)).not.toContain('lucide-triangle-alert');
    expect(classes(icon)).not.toContain('text-[var(--warning)]');
    expect(classes(icon)).toContain('lucide-loader-circle');
  });
});

describe('conversations, not threads', () => {
  it('on the Overview card', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/setup-status')
        return { requiredComplete: 0, requiredTotal: 0, checks: [] };
      if (path === '/admin/health') return { status: 'ok', checks: [] };
      return {
        users: { total: 7, admins: 1 },
        threads: { total: 3, last24h: 1, previous24h: 0 },
        messages: { total: 12, last24h: 4, previous24h: 0 },
        storage: { totalBytes: 0, fileCount: 0 },
        activity: [],
        providers: { configured: 1 },
        models: { total: 1, enabled: 1 },
        system: { version: '0.5.0', database: 'ok', redis: 'ok' },
      };
    });
    ({ root } = await renderAdmin(<AdminOverviewPage />));
    const labels = [...document.querySelectorAll('p')].map((p) => p.textContent?.trim());
    expect(labels).toContain('Conversations');
    expect(labels).not.toContain('Threads');
  });
});
