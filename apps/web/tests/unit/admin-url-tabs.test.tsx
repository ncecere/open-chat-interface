// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateUsageSearch } from '../../src/lib/admin-search';
import { AdminRateLimitsPage } from '../../src/routes/admin/rate-limits';
import { AdminUsagePage } from '../../src/routes/admin/usage';
import { button, cleanup, click, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const range = { days: 90, timezone: 'UTC', exact: true };
const totals = { messages: 3, tokens: 300, costMicros: 1_000, activeUsers: 1 };
const bounded = { entries: [], totalCount: 0 };

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/usage/spend')) {
      return { range, totals, daily: [], models: bounded, consumers: bounded, idleModels: bounded };
    }
    if (path.startsWith('/admin/usage/limits')) return { range, denials: bounded };
    if (path.startsWith('/admin/usage/overview')) {
      return {
        range,
        totals,
        activity: {
          threadsCreated: 1,
          messagesSent: 3,
          attachmentsUploaded: 0,
          sharesCreated: 0,
          searchesRun: 0,
          branchesCreated: 0,
          temporaryThreads: 0,
          erroredResponses: 0,
          cancelledResponses: 0,
        },
        daily: [],
      };
    }
    if (path === '/admin/lifecycle/rate-limits') {
      return {
        roles: Object.fromEntries(
          ['admin', 'auditor', 'user', 'restricted'].map((role) => [
            role,
            { maxConcurrentStreams: 2, chatRequestsPerMinute: 20, uploadRequestsPerMinute: 10 },
          ]),
        ),
        authAttemptsPerMinute: 10,
        reserve: { costMicros: 50_000, tokens: 4_000 },
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function selected(name: string): string | null {
  return button(name).getAttribute('aria-selected');
}

describe('usage tabs in the URL', () => {
  it('opens the tab and range named in the URL', async () => {
    ({ root } = await renderAdmin(<AdminUsagePage />, { path: '/admin/usage?tab=spend&range=90' }));
    expect(selected('Spend')).toBe('true');
    expect(selected('Overview')).toBe('false');
    expect(selected('90 days')).toBe('true');
    expect(api.get).toHaveBeenCalledWith('/admin/usage/spend?days=90');
    expect(document.getElementById('panel-spend')?.getAttribute('role')).toBe('tabpanel');
  });

  it('writes a chosen tab back to the URL and keeps the range', async () => {
    let router: Awaited<ReturnType<typeof renderAdmin>>['router'];
    ({ root, router } = await renderAdmin(<AdminUsagePage />, {
      path: '/admin/usage?range=7',
    }));
    expect(selected('Overview')).toBe('true');
    expect(api.get).toHaveBeenCalledWith('/admin/usage/overview?days=7');

    await click(button('Limits'));
    expect(router.state.location.search).toMatchObject({ tab: 'limits', range: 7 });
    expect(selected('Limits')).toBe('true');
    expect(api.get).toHaveBeenCalledWith('/admin/usage/limits?days=7');

    // Returning to the defaults keeps them out of the URL.
    await click(button('Overview'));
    await click(button('30 days'));
    expect(router.state.location.search).toEqual({});
  });

  it('ignores unknown values', () => {
    expect(validateUsageSearch({ tab: 'secrets', range: 12 })).toEqual({});
    expect(validateUsageSearch({ tab: 'storage', range: '90' })).toEqual({
      tab: 'storage',
      range: 90,
    });
  });
});

describe('rate limit tabs in the URL', () => {
  it('opens the reservations tab from the URL', async () => {
    ({ root } = await renderAdmin(<AdminRateLimitsPage />, {
      path: '/admin/rate-limits?tab=reservations',
    }));
    expect(selected('Reservations')).toBe('true');
    expect(document.getElementById('panel-reservations')?.hidden).toBe(false);
    expect(document.getElementById('panel-roles')?.hidden).toBe(true);
  });
});
