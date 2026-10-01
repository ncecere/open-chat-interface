// @vitest-environment happy-dom
import { updateRateLimitSettingsSchema, upsertStoragePolicySchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import {
  alerts,
  button,
  cleanup,
  click,
  configSourcesFixture,
  rateLimitsFixture,
  renderAdmin,
  roleAccessFixture,
  rolesFixture,
  typeInto,
} from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const GB = 1024 * 1024 * 1024;

let root: Root | undefined;
let roles: ReturnType<typeof rolesFixture>;
beforeEach(() => {
  roles = rolesFixture();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/roles') return roles;
    if (path === '/admin/lifecycle/rate-limits') return rateLimitsFixture();
    if (path === '/admin/lifecycle/config-sources') return configSourcesFixture();
    throw new Error(`Unexpected GET ${path}`);
  });
  api.put.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input #${id}`);
  return element;
}

const roleLoads = () => api.get.mock.calls.filter(([path]) => path === '/admin/roles').length;

describe('Roles & access', () => {
  it('summarises the selected role', async () => {
    roles.roles[3] = roleAccessFixture('restricted', {
      userCount: 4,
      budgets: [
        {
          id: 'budget-1',
          name: 'Daily cap',
          metric: 'cost',
          limitValue: 2_000_000,
          windowKind: 'daily',
          windowHours: null,
          enabled: true,
        },
      ],
    });
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles?role=restricted' }));

    const panel = document.getElementById('role-panel')!;
    expect(panel.textContent).toContain('3 of 4 visible');
    expect(panel.textContent).toContain('Cannot upload attachments.');
    expect(panel.textContent).toContain('Daily cap');
    expect(panel.textContent).toContain('$2.00');
    expect(panel.querySelector('a[href="/admin/models"]')).not.toBeNull();
    expect(panel.querySelector('a[href="/admin/quotas"]')).not.toBeNull();
  });

  it('shows where each rate limit value comes from', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />));

    expect(document.getElementById('rate-user-concurrent-source')?.textContent).toContain(
      'Built-in default',
    );
    expect(document.getElementById('rate-user-chat-source')?.textContent).toContain(
      'From environment',
    );
    expect(document.getElementById('rate-user-upload-source')?.textContent).toContain('Saved');
    expect(document.getElementById('rate-auth-source')?.textContent).toContain('From environment');
    expect(document.getElementById('reserve-tokens-source')?.textContent).toContain('Saved');
  });

  it("saves only the changed field of the selected role's rate limits", async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles?role=restricted' }));
    const save = button('Save rate limits');
    expect(save.disabled).toBe(true);

    await typeInto(input('rate-restricted-chat'), '30');
    expect(save.disabled).toBe(false);
    const before = roleLoads();
    await click(save);

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/admin/lifecycle/rate-limits', {
      roles: { restricted: { chatRequestsPerMinute: 30 } },
    });
    // The mocked request must still be one the server's schema accepts.
    expect(updateRateLimitSettingsSchema.safeParse(api.put.mock.calls[0]?.[1]).success).toBe(true);
    expect(roleLoads()).toBeGreaterThan(before);
  });

  it('refuses a blank or zero rate limit instead of sending it', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />));
    await typeInto(input('rate-user-upload'), '0');

    expect(alerts().join(' ')).toContain('uploads per minute');
    expect(button('Save rate limits').disabled).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('replaces the whole storage allowance for the selected role', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles?role=auditor' }));
    expect(document.getElementById('role-panel')?.textContent).toContain('storage is unlimited');

    await typeInto(input('storage-auditor-total'), '2');
    await click(button('Save allowance'));

    expect(api.put).toHaveBeenCalledWith('/admin/lifecycle/storage-policies/auditor', {
      role: 'auditor',
      maxTotalBytes: 2 * GB,
      maxFileCount: null,
      maxFileBytes: null,
      enabled: true,
    });
    expect(upsertStoragePolicySchema.safeParse(api.put.mock.calls[0]?.[1]).success).toBe(true);
  });

  it('saves instance-wide limits without touching any role', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />));

    await typeInto(input('rate-auth'), '25');
    await typeInto(input('reserve-cost'), '0.10');
    await click(button('Save instance-wide limits'));

    expect(api.put).toHaveBeenCalledWith('/admin/lifecycle/rate-limits', {
      authAttemptsPerMinute: 25,
      reserve: { costMicros: 100_000 },
    });
    expect(updateRateLimitSettingsSchema.safeParse(api.put.mock.calls[0]?.[1]).success).toBe(true);
  });

  it('reports a rejected save next to the form', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.put.mockRejectedValue(new ApiError(400, 'VALIDATION_FAILED', 'Too high.'));
    ({ root } = await renderAdmin(<AdminRolesPage />));

    await typeInto(input('rate-user-concurrent'), '5');
    await click(button('Save rate limits'));

    expect(alerts()).toContain('Rate limits for the user role could not be saved. Too high.');
  });
});
