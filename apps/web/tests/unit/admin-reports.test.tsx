// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminReportsPage, nextRunText } from '../../src/routes/admin/reports';
import { button, cleanup, click, renderAdmin, typeInto } from './admin-test-utils';

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

const DAY = 24 * 60 * 60 * 1000;
const report = {
  id: 'r1',
  name: 'Walk monthly usage',
  cadence: 'monthly' as const,
  windowDays: 30,
  recipients: ['ops@example.edu'],
  enabled: true,
  lastRunAt: new Date(Date.now() - 2 * DAY).toISOString(),
  nextRunAt: new Date(Date.now() + 28 * DAY).toISOString(),
  lastStatus: 'success' as const,
  lastError: null,
};

let root: Root | undefined;
beforeEach(() => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports') return { reports: [report] };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.clearAllMocks();
});

it('says when each report is next sent (#85)', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  expect(nextRunText({ nextRunAt: null }, now)).toBe('Paused');
  expect(nextRunText({ nextRunAt: '2026-10-05T12:00:00Z' }, now)).toBe('Next: within the hour');
  expect(nextRunText({ nextRunAt: '2026-10-05T11:00:00Z' }, now)).toBe('Next: within the hour');
  expect(nextRunText({ nextRunAt: '2026-11-02T12:00:00Z' }, now)).toMatch(/^Next: /);
});

it('counts forward to the next send of a report already sent (#126)', () => {
  // Sent at noon: monthly is due 30 days later, weekly 7. These used to read "Next: just now".
  const now = Date.parse('2026-10-05T12:00:00Z');
  expect(nextRunText({ nextRunAt: '2026-11-04T12:00:00Z' }, now)).toBe('Next: in 30d');
  expect(nextRunText({ nextRunAt: '2026-10-12T12:00:00Z' }, now)).toBe('Next: in 7d');
  expect(nextRunText({ nextRunAt: '2026-10-06T12:00:00Z' }, now)).toBe('Next: in 1d');
});

it('edits a report in place and shows its next run (#85)', async () => {
  ({ root } = await renderAdmin(<AdminReportsPage />));
  expect(document.body.textContent).toContain('Next: in 28d');

  await click(button('Edit Walk monthly usage'));
  const name = document.getElementById('report-name') as HTMLInputElement;
  const recipients = document.getElementById('report-recipients') as HTMLInputElement;
  expect(name.value).toBe('Walk monthly usage');
  expect(recipients.value).toBe('ops@example.edu');

  await typeInto(recipients, 'ops@example.edu, dean@example.edu');
  await click(button('Save report'));
  expect(api.patch).toHaveBeenCalledWith('/admin/reports/r1', {
    name: 'Walk monthly usage',
    cadence: 'monthly',
    windowDays: 30,
    recipients: ['ops@example.edu', 'dean@example.edu'],
  });
  expect(api.post).not.toHaveBeenCalled();
  // Back to adding.
  expect(button('Add report')).toBeTruthy();
  expect(name.value).toBe('');
});

it('shows an empty list as the other admin lists do (#113)', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports') return { reports: [] };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  ({ root } = await renderAdmin(<AdminReportsPage />));
  const empty = document.querySelector('.border-dashed');
  expect(empty?.textContent).toContain('No reports scheduled.');
  expect(empty?.querySelector('svg')).not.toBeNull();
});
