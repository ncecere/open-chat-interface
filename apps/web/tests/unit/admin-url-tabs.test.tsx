// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRolesSearch, validateUsageSearch } from '../../src/lib/admin-search';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import { AdminUsagePage } from '../../src/routes/admin/usage';
import {
  button,
  cleanup,
  click,
  configSourcesFixture,
  rateLimitsFixture,
  renderAdmin,
  rolesFixture,
} from './admin-test-utils';

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
    if (path === '/admin/lifecycle/rate-limits') return rateLimitsFixture();
    if (path === '/admin/roles') return rolesFixture();
    if (path === '/admin/lifecycle/config-sources') return configSourcesFixture();
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

  it('lists the usage of deleted accounts as one row, without identity', async () => {
    const person = {
      deleted: false,
      userId: 'u-1',
      name: 'Ada',
      email: 'ada@example.test',
      messages: 2,
      costMicros: 2_000_000,
    };
    const deleted = {
      deleted: true,
      userId: null,
      name: 'Deleted accounts',
      email: null,
      messages: 5,
      costMicros: 1_000_000,
    };
    api.get.mockImplementation(async () => ({
      range,
      totals,
      daily: [],
      models: bounded,
      consumers: { entries: [person, deleted], totalCount: 2 },
      idleModels: bounded,
    }));
    ({ root } = await renderAdmin(<AdminUsagePage />, { path: '/admin/usage?tab=spend' }));
    const text = document.getElementById('panel-spend')?.textContent ?? '';
    expect(text).toContain('Adaada@example.test$2.00');
    expect(text).toContain('Deleted accountsKept without the people they belonged to$1.00');
    expect(text).toContain('5 messages');
  });

  it('ignores unknown values', () => {
    expect(validateUsageSearch({ tab: 'secrets', range: 12 })).toEqual({});
    expect(validateUsageSearch({ tab: 'storage', range: '90' })).toEqual({
      tab: 'storage',
      range: 90,
    });
  });
});

describe('role tabs in the URL', () => {
  it('opens the role named in the URL and writes a chosen role back', async () => {
    let router: Awaited<ReturnType<typeof renderAdmin>>['router'];
    ({ root, router } = await renderAdmin(<AdminRolesPage />, {
      path: '/admin/roles?role=restricted',
    }));
    expect(selected('Restricted')).toBe('true');
    expect(selected('User')).toBe('false');
    expect(document.getElementById('rate-restricted-chat')).not.toBeNull();
    expect(document.getElementById('rate-user-chat')).toBeNull();

    await click(button('Admin'));
    expect(router.state.location.search).toEqual({ role: 'admin' });
    expect(document.getElementById('rate-admin-chat')).not.toBeNull();

    // The default role keeps the URL clean.
    await click(button('User'));
    expect(router.state.location.search).toEqual({});
  });

  it('defaults to the user role and ignores unknown values', () => {
    expect(validateRolesSearch({ role: 'owner' })).toEqual({});
    expect(validateRolesSearch({ role: 'user' })).toEqual({});
    expect(validateRolesSearch({ role: 'auditor' })).toEqual({ role: 'auditor' });
  });
});
