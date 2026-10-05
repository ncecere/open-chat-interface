// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { AdminUsagePage, fillDays } from '../../src/routes/admin/usage';
import { cleanup, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

it('draws every day of the range, with empty days as zero', () => {
  const filled = fillDays([{ day: '2026-10-05', value: 42 }], 30, '2026-10-05');
  expect(filled).toHaveLength(30);
  expect(filled[0]).toEqual({ day: '2026-09-06', value: 0 });
  expect(filled.at(-1)).toEqual({ day: '2026-10-05', value: 42 });
  expect(filled.filter((point) => point.value > 0)).toHaveLength(1);
});

let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/usage/overview')) {
      return {
        range: { days: 30, timezone: 'UTC', exact: true },
        totals: { messages: 42, tokens: 0, costMicros: 0, activeUsers: 1 },
        activity: {
          threadsCreated: 1,
          messagesSent: 27,
          attachmentsUploaded: 0,
          sharesCreated: 0,
          searchesRun: 0,
          branchesCreated: 0,
          temporaryThreads: 0,
          erroredResponses: 0,
          cancelledResponses: 0,
        },
        daily: [{ day: '2026-10-05', messages: 42, activeUsers: 1 }],
      };
    }
    if (path.startsWith('/admin/usage/spend')) {
      const row = { labId: null, messages: 1, tokens: 10, costMicros: 0, errors: 0 };
      return {
        range: { days: 30, timezone: 'UTC', exact: true },
        totals: { messages: 1, tokens: 10, costMicros: 0, activeUsers: 1 },
        daily: [],
        models: {
          entries: [
            { ...row, modelSlug: 'gpt-4-1-mini', displayName: 'GPT-4.1 mini', enabled: true },
            { ...row, modelSlug: 'old-model', displayName: 'Old model', enabled: false },
            { ...row, modelSlug: 'text-embedding-3-small', displayName: null, enabled: null },
          ],
          totalCount: 3,
        },
        consumers: { entries: [], totalCount: 0 },
        idleModels: { entries: [], totalCount: 0 },
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) await cleanup(root);
  root = undefined;
});

it('says what the chart shows in words, for anyone who cannot hover', async () => {
  ({ root } = await renderAdmin(<AdminUsagePage />, { path: '/admin/usage?range=30' }));
  const chart = document.querySelector('[role="img"]');
  expect(chart?.getAttribute('aria-label')).toBe(
    'Daily replies, 2026-09-06 to 2026-10-05: busiest 2026-10-05 · 42 replies; 1 of 30 days had any.',
  );
  expect(chart?.children).toHaveLength(30);
  // Both ends of the axis, not the same date twice.
  expect(document.body.textContent).toContain('2026-09-06');
  const numbers = document.querySelector('details');
  expect(numbers?.querySelector('summary')?.textContent).toBe('Show the numbers');
  expect(numbers?.textContent).toContain('42 replies');
  // Replies, not "messages": it can exceed Messages sent.
  expect(document.body.textContent).toContain('Replies generated per day');
});

it('labels a disabled model and one outside the chat catalog for what they are', async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AdminUsagePage />
    </ThemeProvider>,
    { path: '/admin/usage?tab=spend&range=30' },
  ));
  const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
  expect(rows.find((row) => row.includes('Old model'))).toContain('disabled');
  // Embedding usage was labelled "removed".
  expect(rows.find((row) => row.includes('text-embedding-3-small'))).toContain('not in catalog');
  expect(rows.find((row) => row.includes('GPT-4.1 mini'))).not.toMatch(/disabled|catalog|removed/);
});
