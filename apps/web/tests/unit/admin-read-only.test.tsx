// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/admin/confirm-dialog';
import { AdminQuotasPage } from '../../src/routes/admin/quotas';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import { AuthenticationSettingsForm } from '../../src/routes/admin/settings/authentication-settings';
import { AdminUsersPage } from '../../src/routes/admin/users';
import {
  button,
  cleanup,
  configSourcesFixture,
  findButton,
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

const user = {
  id: 'user-1',
  name: 'Review User',
  email: 'review@example.test',
  image: null,
  role: 'user',
  emailVerified: true,
  banned: false,
  banReason: null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  threadCount: 2,
  messageCount: 4,
};

const policy = {
  id: 'policy-1',
  name: 'Daily budget',
  description: null,
  metric: 'cost',
  limitValue: 1_000_000,
  windowKind: 'daily',
  windowHours: null,
  timezone: 'UTC',
  enabled: true,
  roles: ['user'],
  modelSlugs: [],
  overrideCount: 0,
};

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/users?')) return { users: [user], total: 1 };
    if (path.startsWith('/admin/views')) return { views: [] };
    if (path === '/admin/quotas') return { policies: [policy] };
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

/** Native rule: a control inside a disabled fieldset is disabled. */
function isDisabled(element: HTMLInputElement | HTMLButtonElement): boolean {
  return element.disabled || element.closest('fieldset[disabled]') !== null;
}

function searchBox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search by name or email..."]',
  );
  if (!input) throw new Error('No search box');
  return input;
}

describe('auditor (read-only) access', () => {
  it('keeps user filters and sorting usable but hides every change', async () => {
    ({ root } = await renderAdmin(<AdminUsersPage />, { role: 'auditor' }));
    expect(document.body.textContent).toContain('Review User');

    expect(isDisabled(searchBox())).toBe(false);
    expect(isDisabled(button('Filter by role'))).toBe(false);
    expect(isDisabled(button('Filter by status'))).toBe(false);
    expect(isDisabled(button('Threads'))).toBe(false);

    expect(document.querySelector('[aria-label="Role for review@example.test"]')).toBeNull();
    expect(findButton('Limits')).toBeUndefined();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('[aria-label="Name for this view"]')).toBeNull();
  });

  it('hides creating, editing and deleting quota policies', async () => {
    ({ root } = await renderAdmin(<AdminQuotasPage />, { role: 'auditor' }));
    expect(document.body.textContent).toContain('Daily budget');
    expect(findButton('New policy')).toBeUndefined();
    expect(findButton('Edit Daily budget')).toBeUndefined();
    expect(findButton('Delete Daily budget')).toBeUndefined();
  });

  it('shows role limits with disabled inputs, usable role tabs and no save buttons', async () => {
    ({ root } = await renderAdmin(<AdminRolesPage />, { role: 'auditor' }));
    const input = document.getElementById('rate-user-chat') as HTMLInputElement;
    expect(input.value).toBe('20');
    expect(isDisabled(input)).toBe(true);
    expect(isDisabled(document.getElementById('storage-user-total') as HTMLInputElement)).toBe(
      true,
    );
    expect(isDisabled(document.getElementById('rate-auth') as HTMLInputElement)).toBe(true);
    expect(findButton('Save rate limits')).toBeUndefined();
    expect(findButton('Save allowance')).toBeUndefined();
    expect(findButton('Save instance-wide limits')).toBeUndefined();
    expect(isDisabled(button('Restricted'))).toBe(false);
  });

  it('drops the save row from settings forms and disables their controls', async () => {
    ({ root } = await renderAdmin(
      <AuthenticationSettingsForm
        initialSettings={{
          registrationMode: 'open',
          emailVerificationRequired: false,
          localAuthEnabled: true,
          sessionLifetimeDays: 30,
        }}
        smtpConfigured
      />,
      { role: 'auditor' },
    ));
    expect(findButton('Save changes')).toBeUndefined();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    expect(isDisabled(document.getElementById('session-lifetime') as HTMLInputElement)).toBe(true);
    expect(
      (document.getElementById('email-verification-required') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('never lets a confirmation dialog run the action', async () => {
    const onConfirm = vi.fn(async () => undefined);
    ({ root } = await renderAdmin(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete thing?"
        description="Gone for good."
        confirmLabel="Delete thing"
        errorMessage="Could not delete."
        onConfirm={onConfirm}
      />,
      { role: 'auditor' },
    ));
    expect(button('Delete thing').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
  });
});

describe('administrator access', () => {
  it('keeps the same controls available', async () => {
    ({ root } = await renderAdmin(<AdminUsersPage />));
    expect(document.querySelector('[aria-label="Role for review@example.test"]')).not.toBeNull();
    expect(button('Limits')).toBeDefined();
    expect(document.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('shows quota and rate limit actions', async () => {
    ({ root } = await renderAdmin(<AdminQuotasPage />));
    expect(button('New policy')).toBeDefined();
    expect(button('Delete Daily budget')).toBeDefined();
  });
});
