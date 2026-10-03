// @vitest-environment happy-dom

import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminUserDetailPage } from '../../src/routes/admin/user-detail';
import { AdminUsersPage } from '../../src/routes/admin/users';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  settle,
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
// The shared test router only has a catch-all route, so supply the parameter.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => ({ userId: 'user-1' }),
}));

const baseUser = {
  id: 'user-1',
  name: 'Dana Admin',
  email: 'dana@example.test',
  image: null,
  role: 'admin',
  emailVerified: true,
  banned: false,
  banReason: null as string | null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  threadCount: 2,
  messageCount: 4,
};

const session = {
  id: 'session-1',
  createdAt: '2026-09-30T00:00:00.000Z',
  expiresAt: '2026-12-30T00:00:00.000Z',
  ipAddress: '203.0.113.5',
  userAgent: 'Test browser',
};

const budget = {
  policyId: 'policy-1',
  name: 'Daily budget',
  metric: 'cost',
  windowKind: 'daily',
  windowHours: null,
  used: 850_000,
  limitValue: 1_000_000,
  remaining: 150_000,
  exceeded: false,
  resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  modelSlugs: [],
  severity: 'warning',
};

const storage = {
  liveBytes: 5 * 1024 * 1024,
  liveFileCount: 3,
  pendingBytes: 0,
  pendingFileCount: 0,
  maxTotalBytes: null as number | null,
  maxFileCount: 10 as number | null,
  maxFileBytes: null as number | null,
};

let user = { ...baseUser };
let allowances: unknown[] = [budget];
let root: Root | undefined;

beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  user = { ...baseUser };
  allowances = [budget];
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/users/user-1') {
      return {
        user,
        storage: { bytesUsed: storage.liveBytes, fileCount: 3 },
        sessions: [session],
        recentThreads: [],
        audit: [],
      };
    }
    if (path === '/admin/users/user-1/limits') {
      return {
        usage: { allowances, recent: { messages: 12, tokens: 3456, costMicros: 250_000 } },
        storage,
      };
    }
    if (path === '/admin/users/user-1/quota-overrides') return { overrides: [] };
    if (path.startsWith('/admin/users?')) return { users: [user], total: 1 };
    if (path.startsWith('/admin/views')) return { views: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockResolvedValue({ id: 'user-1' });
  api.post.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function renderDetail(role: 'admin' | 'auditor' = 'admin') {
  return renderAdmin(<AdminUserDetailPage />, { path: '/admin/users/user-1', role });
}

/** Radix select: the trigger and items open and select on a plain click. */
async function chooseRole(email: string, label: string) {
  await click(button(`Role for ${email}`));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`No option named "${label}"`);
  await click(option);
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('user detail actions', () => {
  it('confirms before removing administrator access and sends the new role', async () => {
    ({ root } = await renderDetail());

    await chooseRole('dana@example.test', 'User');
    expect(dialog()?.textContent).toContain('Remove administrator access from Dana Admin?');
    expect(api.patch).not.toHaveBeenCalled();

    await click(button('Remove administrator access'));
    expect(api.patch).toHaveBeenCalledWith('/admin/users/user-1', { role: 'user' });
    expect(dialog()).toBeNull();
  });

  it('changes a non-administrator role without a confirmation', async () => {
    user = { ...baseUser, role: 'user' };
    ({ root } = await renderDetail());

    await chooseRole('dana@example.test', 'Restricted');
    expect(dialog()).toBeNull();
    expect(api.patch).toHaveBeenCalledWith('/admin/users/user-1', { role: 'restricted' });
  });

  it('shows the server validation error inside the confirmation', async () => {
    api.patch.mockRejectedValueOnce(
      new ApiError(400, 'VALIDATION_FAILED', 'You cannot remove your own administrator role'),
    );
    ({ root } = await renderDetail());

    await chooseRole('dana@example.test', 'Auditor');
    await click(button('Remove administrator access'));

    expect(dialog()).not.toBeNull();
    expect(alerts(dialog() as HTMLElement)).toEqual([
      'The role could not be changed. You cannot remove your own administrator role',
    ]);
  });

  it('bans with a reason and ends every session', async () => {
    user = { ...baseUser, role: 'user' };
    ({ root } = await renderDetail());

    await click(button('Ban'));
    expect(dialog()?.textContent).toContain('signed out of every session');
    await type(document.getElementById('ban-reason') as HTMLInputElement, '  Spam  ');
    await click(button('Ban account'));

    expect(api.patch).toHaveBeenCalledWith('/admin/users/user-1', {
      banned: true,
      banReason: 'Spam',
    });
    // Session revocation is part of the server-side ban.
    expect(api.post).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('shows a banned account prominently and lifts the ban', async () => {
    user = { ...baseUser, role: 'user', banned: true, banReason: 'Abuse report' };
    ({ root } = await renderDetail());

    expect(document.body.textContent).toContain('This account is banned');
    expect(document.body.textContent).toContain('Reason: Abuse report');
    expect(findButton('Ban')).toBeUndefined();

    await click(button('Unban'));
    expect(api.patch).toHaveBeenCalledWith('/admin/users/user-1', {
      banned: false,
      banReason: null,
    });
  });

  it('confirms before signing out everywhere', async () => {
    ({ root } = await renderDetail());

    await click(button('Sign out everywhere'));
    expect(dialog()?.textContent).toContain('This ends 1 active session.');
    expect(api.post).not.toHaveBeenCalled();

    await click(button('End all sessions'));
    expect(api.post).toHaveBeenCalledWith('/admin/users/user-1/revoke-sessions', {});
  });
});

describe('deleting an account', () => {
  function confirmInput() {
    return document.getElementById('delete-user-confirm') as HTMLInputElement;
  }

  it('enables Delete only once the email is typed, then deletes and returns to People', async () => {
    api.delete.mockResolvedValue({ ok: true });
    let router: Awaited<ReturnType<typeof renderDetail>>['router'];
    ({ root, router } = await renderDetail());

    await click(button('Delete user'));
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Delete Dana Admin?');
    expect(text).toContain('conversations and their messages, uploaded files');
    expect(text).toContain('share links');
    expect(text).toContain('The audit log keeps every entry');
    // Usage is kept for reports, without the person (v0.10).
    expect(text).toContain(
      'Usage records (messages, tokens and cost per model) are kept without anything that identifies them',
    );
    expect(text).toContain('reports show them under Deleted accounts');
    expect(text).not.toMatch(/everything it owns:[^.]*usage records/);

    const confirm = [...(dialog() as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Delete user',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(confirmInput(), 'dana@example');
    expect(confirm.disabled).toBe(true);
    await type(confirmInput(), '  DANA@example.test ');
    expect(confirm.disabled).toBe(false);

    await click(confirm);
    expect(api.delete).toHaveBeenCalledWith('/admin/users/user-1');
    expect(router.state.location.pathname).toBe('/admin/users');
  });

  it('shows the server reason and stays open when the deletion is refused', async () => {
    api.delete.mockRejectedValueOnce(
      new ApiError(
        409,
        'CONFLICT',
        'This is the last administrator account, so it cannot be deleted. Make someone else an administrator first.',
      ),
    );
    ({ root } = await renderDetail());

    await click(button('Delete user'));
    await type(confirmInput(), 'dana@example.test');
    const confirm = [...(dialog() as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Delete user',
    ) as HTMLButtonElement;
    await click(confirm);

    expect(dialog()).not.toBeNull();
    expect(alerts(dialog() as HTMLElement)).toEqual([
      'The account could not be deleted. This is the last administrator account, so it cannot be deleted. Make someone else an administrator first.',
    ]);
  });

  it('explains a legal hold and cannot be confirmed', async () => {
    user = { ...baseUser, role: 'user', legalHold: true } as typeof baseUser;
    ({ root } = await renderDetail());

    await click(button('Delete user'));
    expect(dialog()?.textContent).toContain('This person is on legal hold');
    expect(confirmInput()).toBeNull();
    const confirm = [...(dialog() as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Delete user',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('is not offered on your own account', async () => {
    const fallback = api.get.getMockImplementation();
    api.get.mockImplementation(async (path: string) =>
      path === '/me' ? { user: { id: 'user-1' }, preferences: {}, features: {} } : fallback?.(path),
    );
    ({ root } = await renderDetail());

    expect(document.body.textContent).toContain('Dana Admin');
    expect(findButton('Delete user')).toBeUndefined();
  });
});

describe('user limits', () => {
  it('shows each budget with an accessible progress bar, remaining and reset', async () => {
    ({ root } = await renderDetail());

    const bar = document.querySelector('[role="progressbar"][aria-label="Daily budget used"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('850000');
    expect(bar?.getAttribute('aria-valuemax')).toBe('1000000');
    expect(bar?.getAttribute('aria-valuetext')).toBe('$0.85 of $1.00');
    const text = document.body.textContent ?? '';
    expect(text).toContain('$0.85 of $1.00 used');
    expect(text).toContain('Approaching limit');
    expect(text).toContain('$0.15 remaining');
    expect(text).toContain('Resets in 3h');
  });

  it('reports unlimited storage and the file allowance', async () => {
    ({ root } = await renderDetail());

    const text = document.body.textContent ?? '';
    expect(text).toContain('5.0 MB · Unlimited');
    expect(text).toContain('3 files of 10 files');
    expect(document.querySelector('[aria-label="Storage used"]')).toBeNull();
    expect(document.querySelector('[aria-label="Files used"]')?.getAttribute('aria-valuenow')).toBe(
      '3',
    );
  });

  it('shows recent usage when no budgets apply', async () => {
    allowances = [];
    ({ root } = await renderDetail());

    const text = document.body.textContent ?? '';
    expect(text).toContain('No budgets apply to this role.');
    expect(text).toContain('3,456');
    expect(text).toContain('$0.25');
  });

  it('links to role settings and opens the override dialog', async () => {
    ({ root } = await renderDetail());

    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Role settings',
    );
    expect(link?.getAttribute('href')).toBe('/admin/roles?role=admin');

    await click(button('Adjust limits'));
    expect(dialog()?.textContent).toContain('Usage limits for Dana Admin');
  });
});

describe('read-only viewers', () => {
  it('see the account and its limits without any action controls', async () => {
    ({ root } = await renderDetail('auditor'));

    expect(document.body.textContent).toContain('Daily budget');
    expect(findButton('Role for dana@example.test')).toBeUndefined();
    expect(findButton('Ban')).toBeUndefined();
    expect(findButton('Unban')).toBeUndefined();
    expect(findButton('Sign out everywhere')).toBeUndefined();
    expect(findButton('Adjust limits')).toBeUndefined();
    expect(findButton('Delete user')).toBeUndefined();
  });
});

describe('users list role control', () => {
  it('replaces the admin toggle with a role select that confirms granting admin', async () => {
    user = { ...baseUser, role: 'user' };
    ({ root } = await renderAdmin(<AdminUsersPage />));

    expect(findButton('Make admin')).toBeUndefined();
    await chooseRole('dana@example.test', 'Admin');
    expect(dialog()?.textContent).toContain('Make Dana Admin an administrator?');

    await click(button('Make administrator'));
    expect(api.patch).toHaveBeenCalledWith('/admin/users/user-1', { role: 'admin' });
  });

  it('shows a role badge rather than a select to auditors', async () => {
    ({ root } = await renderAdmin(<AdminUsersPage />, { role: 'auditor' }));
    expect(findButton('Role for dana@example.test')).toBeUndefined();
    expect(document.body.textContent).toContain('Admin');
  });
});
