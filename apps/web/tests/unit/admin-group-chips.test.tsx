// @vitest-environment happy-dom
import type { AdminModel, QuotaPolicy } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserGroupsSection } from '../../src/components/admin/user-groups';
import { UserLimitsSection } from '../../src/components/admin/user-limits';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { AdminModelsPage } from '../../src/routes/admin/models';
import { AdminQuotasPage } from '../../src/routes/admin/quotas';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import {
  button,
  buttonNames,
  cleanup,
  click,
  configSourcesFixture,
  dialog,
  rateLimitsFixture,
  renderAdmin,
  rolesFixture,
} from './admin-test-utils';

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

const biology = { id: 'group-1', name: 'Biology' };
const chemistry = { id: 'group-2', name: 'Chemistry' };

function policy(overrides: Partial<QuotaPolicy> = {}): QuotaPolicy {
  return {
    id: 'policy-1',
    name: 'Biology monthly',
    description: null,
    metric: 'messages',
    limitValue: 500,
    windowKind: 'monthly',
    windowHours: null,
    timezone: 'UTC',
    enabled: true,
    roles: ['user'],
    modelSlugs: [],
    overrideCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function adminModel(overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id: 'm1',
    slug: 'big-model',
    displayName: 'Big model',
    description: null,
    providerId: 'p1',
    providerKind: 'openai',
    providerLabel: 'OpenAI',
    labId: 'openai',
    upstreamModelId: 'big-model',
    capabilities: [],
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    inputPriceMicros: null,
    outputPriceMicros: null,
    isDefault: true,
    sortOrder: 0,
    enabled: true,
    visibleToRoles: ['admin', 'user'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** The groups shown in `scope`, as the links they are: name and where they go. */
const chips = (scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLAnchorElement>('a[href^="/admin/groups/"]')].map((link) => [
    link.textContent,
    link.getAttribute('href'),
  ]);

describe('groups on a budget', () => {
  it('names each group the budget is attached to, linking to the group', async () => {
    api.get.mockResolvedValue({
      policies: [
        policy({ groups: [biology, chemistry] }),
        policy({ id: 'policy-2', name: 'Everyone', groups: [] }),
        policy({ id: 'policy-3', name: 'Older server' }),
      ],
    });
    ({ root } = await renderAdmin(<AdminQuotasPage />));
    const rows = [...document.querySelectorAll('[class*="divide-y"] > div')];
    expect(chips(rows[0])).toEqual([
      ['Biology', '/admin/groups/group-1'],
      ['Chemistry', '/admin/groups/group-2'],
    ]);
    // A list that is there says what it is; none where there are no groups.
    expect(rows[0]?.querySelector('ul')?.getAttribute('aria-label')).toBe(
      'Groups with this budget',
    );
    expect(rows[1]?.querySelector('ul')).toBeNull();
    expect(rows[2]?.querySelector('ul')).toBeNull();
  });

  it('shows them read-only: set from the group, nothing here removes one', async () => {
    api.get.mockResolvedValue({ policies: [policy({ groups: [biology] })] });
    ({ root } = await renderAdmin(<AdminQuotasPage />));
    expect(buttonNames()).not.toContain('Remove Biology');
    expect(document.body.textContent).toContain('Groups are chosen on each group’s own page');
  });

  it('never sends groups when the budget is saved, so a client cannot wipe them', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/quotas' ? { policies: [policy({ groups: [biology] })] } : { models: [] },
    );
    api.put.mockResolvedValue({});
    ({ root } = await renderAdmin(<AdminQuotasPage />));
    await click(button('Edit Biology monthly'));
    await click(
      [...dialog()!.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Save changes',
      )!,
    );
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0]?.[1]).not.toHaveProperty('groups');
    expect(api.put.mock.calls[0]?.[1]).not.toHaveProperty('groupIds');
  });
});

describe('groups on a model', () => {
  function modelsApi(model: AdminModel) {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/models') return { models: [model] };
      if (path === '/admin/providers')
        return {
          providers: [
            {
              id: 'p1',
              label: 'OpenAI',
              kind: 'openai',
              enabled: true,
              baseUrl: 'https://gateway.example.edu/v1',
              credentialHint: 'sk-…1234',
              modelCount: 1,
            },
          ],
        };
      if (path === '/admin/setup-status') return { checks: [] };
      throw new Error(`Unexpected GET ${path}`);
    });
  }
  const render = async () => {
    ({ root } = await renderAdmin(
      <ThemeProvider>
        <AdminModelsPage />
      </ThemeProvider>,
      { path: '/admin/models?tab=models' },
    ));
  };

  it('counts them on the row, and names them, as links, where the model opens', async () => {
    modelsApi(adminModel({ groups: [biology, chemistry] }));
    await render();
    expect(document.body.textContent).toContain('2 groups');
    await click(document.querySelector('button.min-w-0.flex-1') as HTMLElement);
    expect(chips()).toEqual([
      ['Biology', '/admin/groups/group-1'],
      ['Chemistry', '/admin/groups/group-2'],
    ]);
    expect(document.querySelector('ul[aria-label="Groups granted this model"]')).not.toBeNull();
  });

  it('says nothing about groups for a model no group is granted', async () => {
    modelsApi(adminModel({ groups: [] }));
    await render();
    expect(document.body.textContent).not.toContain('group');
    await click(document.querySelector('button.min-w-0.flex-1') as HTMLElement);
    expect(document.querySelector('ul[aria-label="Groups granted this model"]')).toBeNull();
  });

  it('never sends groups when a model is saved', async () => {
    modelsApi(adminModel({ groups: [biology] }));
    api.patch.mockResolvedValue({});
    await render();
    await click(button('Edit Big model'));
    await click(
      [...dialog()!.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Save model',
      )!,
    );
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]?.[1]).not.toHaveProperty('groups');
    expect(api.patch.mock.calls[0]?.[1]).not.toHaveProperty('groupIds');
  });
});

describe('a person’s groups on their page', () => {
  it('lists them, with the role the person has in each', async () => {
    api.get.mockResolvedValue({
      groups: [
        { ...biology, role: 'manager' },
        { ...chemistry, role: 'member' },
      ],
    });
    ({ root } = await renderAdmin(<UserGroupsSection userId="user-1" />));
    expect(api.get).toHaveBeenCalledWith('/admin/users/user-1/groups');
    expect(document.querySelector('h2')?.textContent).toBe('Groups');
    expect(chips()).toEqual([
      ['Biology', '/admin/groups/group-1'],
      ['Chemistry', '/admin/groups/group-2'],
    ]);
    const items = [...document.querySelectorAll('li')].map((item) => item.textContent);
    expect(items[0]).toContain('Manager');
    expect(items[1]).toContain('Member');
  });

  it('says when they are in none', async () => {
    api.get.mockResolvedValue({ groups: [] });
    ({ root } = await renderAdmin(<UserGroupsSection userId="user-1" />));
    expect(document.body.textContent).toContain('Not in any group.');
  });

  it('offers a retry when the groups cannot be read', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    ({ root } = await renderAdmin(<UserGroupsSection userId="user-1" />));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Groups could not be loaded.',
    );
  });
});

describe('where each of a person’s budgets comes from', () => {
  const user = {
    id: 'user-1',
    name: 'Dana',
    email: 'dana@example.test',
    image: null,
    role: 'user',
    emailVerified: true,
    banned: false,
    banReason: null,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    threadCount: 0,
    messageCount: 0,
  } as never;
  const allowance = (policyId: string, name: string) => ({
    policyId,
    name,
    metric: 'messages',
    windowKind: 'daily',
    windowHours: null,
    used: 1,
    limitValue: 10,
    remaining: 9,
    exceeded: false,
    resetsAt: null,
    modelSlugs: [],
    severity: 'ok',
  });
  const storage = {
    liveBytes: 0,
    liveFileCount: 0,
    pendingBytes: 0,
    pendingFileCount: 0,
    maxTotalBytes: null,
    maxFileCount: null,
    maxFileBytes: null,
  };

  async function render(budgetSources?: Record<string, unknown>) {
    api.get.mockResolvedValue({
      usage: {
        allowances: [
          allowance('policy-1', 'Role budget'),
          allowance('policy-2', 'Group budget'),
          allowance('policy-3', 'Both budget'),
        ],
        recent: { messages: 0, tokens: 0, costMicros: 0 },
      },
      storage,
      ...(budgetSources ? { budgetSources } : {}),
    });
    ({ root } = await renderAdmin(<UserLimitsSection user={user} />));
  }

  const row = (name: string) =>
    [...document.querySelectorAll('li')].find((item) => item.textContent?.includes(name))!;

  it('says role or group for each budget, naming the group', async () => {
    await render({
      'policy-1': [{ kind: 'role' }],
      'policy-2': [{ kind: 'group', groupId: 'group-1', groupName: 'Biology' }],
      'policy-3': [
        { kind: 'role' },
        { kind: 'group', groupId: 'group-1', groupName: 'Biology' },
        { kind: 'group', groupId: 'group-2', groupName: 'Chemistry' },
      ],
    });
    expect(row('Role budget').textContent).toContain('From the user role');
    expect(row('Role budget').querySelector('a')).toBeNull();
    expect(row('Group budget').textContent).toContain('From the group Biology');
    expect(chips(row('Group budget'))).toEqual([['Biology', '/admin/groups/group-1']]);
    const both = row('Both budget').textContent ?? '';
    expect(both).toContain('From the user role, the group Biology and the group Chemistry');
  });

  it('says nothing about sources when the server does not send them', async () => {
    await render();
    expect(document.body.textContent).not.toContain('From the');
  });
});

describe('Roles & access: Groups', () => {
  const groups = [
    {
      id: 'group-1',
      name: 'Biology',
      memberCount: 12,
      managerCount: 1,
      budgets: [
        { id: 'policy-1', name: 'Biology monthly', enabled: true },
        { id: 'policy-3', name: 'Paused', enabled: false },
      ],
      models: [{ id: 'm1', displayName: 'Big model', enabled: true }],
    },
    { id: 'group-2', name: 'Empty', memberCount: 0, managerCount: 0, budgets: [], models: [] },
  ];

  async function render(roles: unknown) {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/roles') return roles;
      if (path === '/admin/lifecycle/rate-limits') return rateLimitsFixture();
      if (path === '/admin/lifecycle/config-sources') return configSourcesFixture();
      throw new Error(`Unexpected GET ${path}`);
    });
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles' }));
  }

  it('lists each group with its people, budgets and extra models, read-only', async () => {
    await render({ ...rolesFixture(), groups });
    const section = document.querySelector('section[aria-labelledby="role-groups-heading"]')!;
    expect(section.querySelector('h2')?.textContent).toBe('Groups');
    const text = section.textContent ?? '';
    expect(text).toContain('Groups add to a role; they never take access away.');
    expect(text).toContain('Biology');
    expect(text).toContain('12 members');
    expect(text).toContain('1 manager');
    expect(text).toContain('Biology monthly');
    expect(text).toContain('Paused');
    expect(text).toContain('not enforced');
    expect(text).toContain('Big model');
    expect(chips(section)).toContainEqual(['Biology', '/admin/groups/group-1']);
    expect(section.querySelector('a[href="/admin/groups"]')).not.toBeNull();
    // Read-only: nothing here changes a group.
    expect(section.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
  });

  it('says there are none yet, and where to make one', async () => {
    await render({ ...rolesFixture(), groups: [] });
    const section = document.querySelector('section[aria-labelledby="role-groups-heading"]')!;
    expect(section.textContent).toContain('No groups yet.');
    expect(section.querySelector('a[href="/admin/groups"]')).not.toBeNull();
  });

  it('is left out when the server does not know groups', async () => {
    await render(rolesFixture());
    expect(document.querySelector('section[aria-labelledby="role-groups-heading"]')).toBeNull();
  });
});
