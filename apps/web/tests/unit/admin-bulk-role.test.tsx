// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UserBulkToolbar } from '../../src/routes/admin/users/bulk-toolbar';
import { button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';

// The toolbar asks who is signed in, to leave your own account out of its counts.
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api: { get: async () => ({ user: { id: 'me' }, preferences: {}, features: {} }) },
}));

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function selection(bulkRole: 'admin' | 'user', ids = ['user-1', 'user-2']) {
  return {
    selected: new Set(ids),
    bulkRole,
    setBulkRole: vi.fn(),
    clear: vi.fn(),
    bulk: {
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ ok: true }),
      isPending: false,
      error: null,
      data: undefined,
      variables: undefined,
    },
  } as unknown as Parameters<typeof UserBulkToolbar>[0]['selection'];
}

it('asks before making the selected accounts administrators', async () => {
  const chosen = selection('admin');
  ({ root } = await renderAdmin(<UserBulkToolbar selection={chosen} />));

  await click(button('Apply role'));
  expect(chosen.bulk.mutate).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Make 2 accounts administrators?');

  await click(button('Make 2 accounts administrators'));
  expect(chosen.bulk.mutateAsync).toHaveBeenCalledWith({ action: 'set_role', role: 'admin' });
});

it('makes one account "an administrator", in the title and on the button (#219)', async () => {
  // Yourself and one other: yours is skipped, so one account changes.
  const chosen = selection('admin', ['me', 'user-1']);
  ({ root } = await renderAdmin(<UserBulkToolbar selection={chosen} />));

  await click(button('Apply role'));
  expect(dialog()?.textContent).toContain('Make 1 account an administrator?');
  await click(button('Make 1 account an administrator'));
  expect(chosen.bulk.mutateAsync).toHaveBeenCalledWith({ action: 'set_role', role: 'admin' });
});

it('applies other roles at once', async () => {
  const chosen = selection('user');
  ({ root } = await renderAdmin(<UserBulkToolbar selection={chosen} />));

  await click(button('Apply role'));
  expect(dialog()).toBeNull();
  expect(chosen.bulk.mutate).toHaveBeenCalledWith({ action: 'set_role', role: 'user' });
});
