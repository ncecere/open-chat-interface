// @vitest-environment happy-dom
import {
  updateRateLimitSettingsSchema,
  updateRoleFeaturesSchema,
  upsertStoragePolicySchema,
} from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import {
  alerts,
  button,
  cleanup,
  click,
  configSourcesFixture,
  findButton,
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

function featureSwitch(role: string, key: string): HTMLButtonElement {
  const element = document.getElementById(`role-${role}-feature-${key}`);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`No switch for ${key}`);
  return element;
}

function isDisabled(element: HTMLInputElement | HTMLButtonElement): boolean {
  return element.disabled || element.closest('fieldset[disabled]') !== null;
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
    // Feature limits are role settings now, not fixed rules.
    expect(panel.textContent).not.toContain('Fixed rules');
    expect(panel.textContent).toContain('Daily cap');
    expect(panel.textContent).toContain('$2.00');
    expect(panel.querySelector('a[href="/admin/models?tab=models"]')).not.toBeNull();
    expect(panel.querySelector('a[href="/admin/quotas"]')).not.toBeNull();
  });

  it("shows the selected role's feature switches and reasoning levels", async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles?role=restricted' }));

    expect(featureSwitch('restricted', 'attachments').getAttribute('aria-checked')).toBe('false');
    expect(featureSwitch('restricted', 'shareLinks').getAttribute('aria-checked')).toBe('false');
    expect(featureSwitch('restricted', 'temporaryChat').getAttribute('aria-checked')).toBe('false');
    expect(featureSwitch('restricted', 'webSearch').getAttribute('aria-checked')).toBe('true');
    expect(featureSwitch('restricted', 'branching').getAttribute('aria-checked')).toBe('true');
    expect(featureSwitch('restricted', 'projects').getAttribute('aria-checked')).toBe('false');
    expect(
      document.getElementById('role-restricted-feature-projects-description')?.textContent,
    ).toContain('Group conversations under shared instructions and files');
    // On for the role but off instance-wide: the page says why it is unavailable.
    expect(
      document.getElementById('role-restricted-feature-webSearch-description')?.textContent,
    ).toContain('Unavailable until web search is switched on');
    expect(document.getElementById('role-panel')?.textContent).toContain('General settings');

    const instant = input('role-restricted-effort-instant');
    expect(instant.checked).toBe(true);
    expect(instant.disabled).toBe(true);
    expect(input('role-restricted-effort-high').checked).toBe(true);
    expect(button('Save features').disabled).toBe(true);
  });

  it('saves only the changed features for the selected role', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { path: '/admin/roles?role=restricted' }));

    await click(featureSwitch('restricted', 'attachments'));
    await click(input('role-restricted-effort-high'));
    // Toggled twice: back to the saved value, so it must not be sent.
    await click(featureSwitch('restricted', 'branching'));
    await click(featureSwitch('restricted', 'branching'));
    const before = roleLoads();
    await click(button('Save features'));

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/admin/roles/restricted', {
      attachments: true,
      reasoningEfforts: ['instant', 'low', 'medium'],
    });
    expect(updateRoleFeaturesSchema.safeParse(api.put.mock.calls[0]?.[1]).success).toBe(true);
    expect(roleLoads()).toBeGreaterThan(before);
  });

  it('reports a rejected feature save next to the form', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.put.mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Instant is always allowed.'));
    ({ root } = await renderAdmin(<AdminRolesPage />));

    await click(featureSwitch('user', 'webSearch'));
    await click(button('Save features'));

    expect(api.put).toHaveBeenCalledWith('/admin/roles/user', { webSearch: false });
    expect(alerts()).toContain(
      'Features for the user role could not be saved. Instant is always allowed.',
    );
  });

  it('shows features read-only to an auditor', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { role: 'auditor' }));

    expect(isDisabled(featureSwitch('user', 'attachments'))).toBe(true);
    expect(isDisabled(input('role-user-effort-low'))).toBe(true);
    expect(findButton('Save features')).toBeUndefined();
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
