// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminPoliciesPage } from '../../src/routes/admin/policies';
import { AdminReportsPage } from '../../src/routes/admin/reports';
import { AdminRetentionPage } from '../../src/routes/admin/retention';
import { BudgetList } from '../../src/routes/admin/roles/budget-list';
import { cleanup, renderAdmin, roleAccessFixture } from './admin-test-utils';

// Wording that read "1 days", or said what the page no longer does (#286).

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
  vi.resetAllMocks();
});

const text = () => document.body.textContent ?? '';

it('Reports lists a one-day window as "1 day"', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports')
      return {
        reports: [
          {
            id: 'r1',
            name: 'Fix5 daily',
            cadence: 'monthly',
            windowDays: 1,
            recipients: ['admin@northbrook.edu'],
            enabled: true,
            lastRunAt: null,
            nextRunAt: null,
            lastStatus: null,
            lastError: null,
          },
        ],
      };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  ({ root } = await renderAdmin(<AdminReportsPage />));
  expect(text()).toContain('monthly · 1 day · admin@northbrook.edu');
  expect(text()).not.toContain('1 days');
});

it('Retention calls its time zone the fallback for the date models are told, and counts days', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/lifecycle/retention')
      return {
        trashRetentionDays: 1,
        threadRetentionDays: 1,
        exemptPinnedThreads: true,
        usageEventRetentionDays: 365,
        auditLogRetentionDays: 365,
        memoryRetentionDays: null,
        displayTimezone: 'UTC',
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  ({ root } = await renderAdmin(<AdminRetentionPage />));
  expect(text()).toContain(
    "the zone of the date models are told when a person's browser does not give its own",
  );
  expect(text()).toContain(
    'Conversations with no activity for 1 day move to the trash, then are destroyed 1 day later.',
  );
});

it('Acceptable use says a published version can never be deleted, accepted or not', async () => {
  api.get.mockResolvedValue({ policies: [] });
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  expect(text()).toContain('a published version can never be changed or deleted');
  expect(text()).not.toContain('once somebody has accepted it');
});

it('a role’s budget list says "Rolling 1 hour" and "1 message"', async () => {
  const access = roleAccessFixture('user', {
    budgets: [
      {
        id: 'b1',
        name: 'Fix5 hourly',
        metric: 'messages',
        limitValue: 1,
        windowKind: 'rolling',
        windowHours: 1,
        enabled: true,
      },
    ],
  });
  ({ root } = await renderAdmin(<BudgetList access={access as never} />));
  expect(text()).toContain('Rolling 1 hour');
  expect(text()).toContain('1 message');
  expect(text()).not.toMatch(/1 hours|1 messages/);
});
