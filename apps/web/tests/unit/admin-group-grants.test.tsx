// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminGroupDetailPage } from '../../src/routes/admin/group-detail';
import {
  alerts,
  button,
  cleanup,
  click,
  dismissToasts,
  findButton,
  renderAdmin,
  typeInto,
} from './admin-test-utils';
import { groupDetail, membersPage, usage } from './groups-fixtures';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => ({ groupId: 'group-1' }),
}));

const policies = [
  { id: 'policy-1', name: 'Biology monthly', enabled: true, roles: ['user'] },
  { id: 'policy-2', name: 'Heavy users', enabled: true, roles: [] },
  { id: 'policy-3', name: 'Paused budget', enabled: false, roles: [] },
];
const models = [
  { id: 'model-1', slug: 'alpha', displayName: 'Alpha', labId: null, enabled: true },
  { id: 'model-2', slug: 'gamma', displayName: 'Gamma', labId: null, enabled: false },
  { id: 'model-3', slug: 'delta', displayName: 'Delta', labId: null, enabled: true },
];

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/groups/group-1') return groupDetail();
    if (path.startsWith('/admin/groups/group-1/members')) return membersPage();
    if (path === '/admin/quotas') return { policies };
    if (path === '/admin/models') return { models };
    if (path.startsWith('/admin/groups/group-1/usage')) return usage();
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
});

async function render(role: 'admin' | 'auditor' = 'admin', tab = 'grants') {
  ({ root } = await renderAdmin(<AdminGroupDetailPage />, {
    path: `/admin/groups/group-1?tab=${tab}`,
    role,
  }));
}

const box = (name: string) => {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (candidate) => candidate.closest('label')?.textContent?.includes(name),
  );
  if (!input) throw new Error(`No checkbox for ${name}`);
  return input;
};

describe('Budgets and models', () => {
  it('shows every budget and model with what the group grants already ticked', async () => {
    await render();
    expect(box('Biology monthly').checked).toBe(true);
    expect(box('Heavy users').checked).toBe(false);
    expect(box('Alpha').checked).toBe(true);
    expect(box('Gamma').checked).toBe(true);
    expect(box('Delta').checked).toBe(false);
    // Said where the person is choosing, since it is the thing people expect otherwise.
    const text = document.body.textContent ?? '';
    expect(text).toContain('never raises a limit');
    expect(text).toContain('Not enforced');
    expect(text).toContain('Disabled');
  });

  it('labels every checkbox by its budget or model', async () => {
    await render();
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(input.closest('label')?.textContent?.trim()).not.toBe('');
    }
  });

  it('writes both lists to the group’s own grants endpoint and nowhere else', async () => {
    api.put.mockResolvedValue({ policies: [], models: [] });
    await render();
    expect((button('Save grants') as HTMLButtonElement).disabled).toBe(true);

    await click(box('Heavy users'));
    await click(box('Delta'));
    await click(box('Gamma'));
    await click(button('Save grants'));

    expect(api.put).toHaveBeenCalledTimes(1);
    const [path, body] = api.put.mock.calls[0] as [
      string,
      { policyIds: string[]; modelIds: string[] },
    ];
    expect(path).toBe('/admin/groups/group-1/grants');
    expect([...body.policyIds].sort()).toEqual(['policy-1', 'policy-2']);
    expect([...body.modelIds].sort()).toEqual(['model-1', 'model-3']);
    // Never through the budget or model forms: the API refuses it and a client that omits roles would wipe them.
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Saved.');
  });

  it('sends both lists even when only one changed (the API replaces both)', async () => {
    api.put.mockResolvedValue({ policies: [], models: [] });
    await render();
    await click(box('Heavy users'));
    await click(button('Save grants'));
    const [, body] = api.put.mock.calls[0] as [string, { policyIds: string[]; modelIds: string[] }];
    expect([...body.modelIds].sort()).toEqual(['model-1', 'model-2']);
  });

  it('keeps a grant the lists no longer show, rather than silently dropping it', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/groups/group-1') return groupDetail();
      if (path === '/admin/quotas') return { policies: [] };
      if (path === '/admin/models') return { models: [] };
      return membersPage();
    });
    await render();
    expect(box('Biology monthly').checked).toBe(true);
    expect(box('Alpha').checked).toBe(true);
  });

  it('filters the models by name', async () => {
    await render();
    await typeInto(document.querySelector('input[aria-label="Search models"]')!, 'alp');
    const names = [...document.querySelectorAll('input[type="checkbox"]')].map(
      (input) => input.closest('label')?.textContent ?? '',
    );
    expect(names.some((name) => name.includes('Alpha'))).toBe(true);
    expect(names.some((name) => name.includes('Delta'))).toBe(false);
    // A filter hides rows; it never changes what is ticked.
    expect(box('Alpha').checked).toBe(true);
  });

  it('shows the server’s refusal while an upgrade is running, and keeps the choices', async () => {
    api.put.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'An upgrade is still in progress', {
        reason: 'upgrade_in_progress',
      }),
    );
    await render();
    await click(box('Delta'));
    await click(button('Save grants'));
    expect(alerts()).toContain('An upgrade is still in progress');
    expect(box('Delta').checked).toBe(true);
    expect((button('Save grants') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a chosen budget or model has gone, and to look again', async () => {
    api.put.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'Unknown budget or model', {
        reason: 'unknown_grant',
        ids: ['policy-9'],
      }),
    );
    await render();
    await click(box('Delta'));
    await click(button('Save grants'));
    expect(alerts().join(' ')).toContain('no longer exists');
  });

  it('is read-only for an auditor: everything ticked can be read, nothing changed', async () => {
    await render('auditor');
    expect(box('Alpha').checked).toBe(true);
    expect(box('Alpha').closest('fieldset[disabled]')).not.toBeNull();
    expect(findButton('Save grants')).toBeUndefined();
  });

  it('offers the lists as groups of controls with names', async () => {
    await render();
    const groups = [...document.querySelectorAll('fieldset[aria-labelledby]')].map(
      (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
    );
    expect(groups).toEqual(expect.arrayContaining(['Budgets', 'Models']));
  });
});

describe('Usage', () => {
  it('says it is the current members, for the last 30 days, and totals them', async () => {
    await render('admin', 'usage');
    expect(api.get).toHaveBeenCalledWith('/admin/groups/group-1/usage?days=30');
    const text = document.body.textContent ?? '';
    expect(text).toContain('current members');
    expect(text).toContain('last 30 days');
    expect(text).toContain('120');
    expect(text).toContain('4,000');
    expect(text).toContain('9,000');
    expect(text).toContain('$2.50');
    expect(text).toContain('Ada Lovelace');
  });

  it('reads another range', async () => {
    await render('admin', 'usage');
    await click(button('Last 7 days'));
    expect(api.get).toHaveBeenCalledWith('/admin/groups/group-1/usage?days=7');
    expect(document.body.textContent).toContain('last 7 days');
  });

  it('says when the busiest people are cut short', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/groups/group-1'
        ? groupDetail()
        : path.includes('/usage')
          ? usage({ truncated: true })
          : membersPage(),
    );
    await render('admin', 'usage');
    expect(document.body.textContent).toContain('busiest');
  });

  it('reads the same for an auditor', async () => {
    await render('auditor', 'usage');
    expect(document.body.textContent).toContain('Ada Lovelace');
  });

  it('offers a retry when the usage cannot be read', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/groups/group-1') return groupDetail();
      if (path.includes('/usage')) throw new ApiError(500, 'INTERNAL_ERROR', 'Reports are away');
      return membersPage();
    });
    await render('admin', 'usage');
    expect(alerts()).toContain('Usage could not be loaded.');
  });
});
