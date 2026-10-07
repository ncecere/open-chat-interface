// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminUsersPage } from '../../src/routes/admin/users';
import { button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';

// The bulk bar on the real Users page, with its real selection hook (#145).

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

const account = (id: string, email: string, role: string) => ({
  id,
  name: email.split('@')[0],
  email,
  image: null,
  role,
  emailVerified: true,
  banned: false,
  banReason: null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  threadCount: 0,
  messageCount: 0,
});
const users = [
  account('me', 'admin@example.test', 'admin'),
  account('other', 'walk3-invitee@example.test', 'user'),
];

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me' }, preferences: {}, features: {} };
    if (path.startsWith('/admin/users?')) return { users, total: users.length };
    if (path.startsWith('/admin/views')) return { views: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function selectBoth() {
  ({ root } = await renderAdmin(<AdminUsersPage />));
  for (const user of users) {
    const box = document.querySelector<HTMLInputElement>(
      `input[aria-label="Select ${user.email}"]`,
    );
    await click(box!);
  }
  expect(document.body.textContent).toContain('2 accounts selected');
}

it('counts only the accounts that will change when making administrators', async () => {
  await selectBoth();
  const role = button('Role to apply');
  await click(role);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'Admin',
    )!,
  );
  await click(button('Apply role'));
  expect(dialog()?.textContent).toContain('Make 1 account an administrator?');
  expect(dialog()?.textContent).toContain(
    'Your own account is selected but will be left unchanged.',
  );
});

it('asks before signing accounts out, then says what it did', async () => {
  await selectBoth();
  await click(button('Sign out'));
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Sign 1 account out everywhere?');

  api.post.mockResolvedValue({ affected: 1, skippedSelf: true, sessionsEnded: 3 });
  await click(button('Sign out 1 account'));
  expect(api.post).toHaveBeenCalledWith('/admin/users/bulk', {
    userIds: ['me', 'other'],
    action: 'revoke_sessions',
  });
  expect(dialog()).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    'Signed out 1 account, ending 3 sessions. Your own account was left unchanged.',
  );
});
