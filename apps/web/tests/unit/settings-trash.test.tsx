// @vitest-environment happy-dom
import type { TrashedThread } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsHistoryPage } from '../../src/routes/settings/history';
import { button, cleanup, click, dialog, findButton, renderAdmin } from './admin-test-utils';

/**
 * Settings → History → Trash (#132): deleting now, one conversation or the
 * whole trash, asks first; each row's buttons are named for the row.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const DAY = 86_400_000;
function trashed(id: string, title: string, messageCount: number): TrashedThread {
  return {
    id,
    title,
    messageCount,
    deletedAt: new Date(Date.now() - DAY).toISOString(),
    purgeAt: new Date(Date.now() + 29 * DAY).toISOString(),
    deletedReason: 'user',
  } as TrashedThread;
}

let trash: TrashedThread[];
let root: Root | undefined;
beforeEach(() => {
  trash = [trashed('a', 'Budget review', 4), trashed('b', 'Lab notes', 1)];
  // Stateful, as the server is: a deleted conversation leaves the trash.
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/threads/trash') return { threads: trash };
    if (path === '/me')
      return { user: { id: 'u1', name: 'Ada', role: 'user' }, preferences: {}, features: {} };
    if (path === '/projects') return { projects: [] };
    if (path === '/me/imports') return { imports: [] };
    if (path.startsWith('/threads?')) return { threads: [], nextCursor: null };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.delete.mockReset().mockImplementation(async (path: string) => {
    if (path === '/threads/trash') {
      const purged = trash.length;
      trash = [];
      return { purged };
    }
    const id = path.split('/')[2];
    trash = trash.filter((thread) => thread.id !== id);
    return { ok: true };
  });
  api.post.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsHistoryPage />, { path: '/settings/history' }));
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent === 'Trash',
  )!;
  await click(tab);
};
const titles = () =>
  [...document.querySelectorAll('p.truncate.text-sm')].map((node) => node.textContent);

describe('Trash', () => {
  it('names each row’s Restore and Delete now for its conversation', async () => {
    await render();
    const labels = [...document.querySelectorAll('[role="tabpanel"] button')].map(
      (node) => node.getAttribute('aria-label') ?? node.textContent,
    );
    expect(labels).toEqual([
      'Empty trash',
      'Restore Budget review',
      'Delete Budget review now',
      'Restore Lab notes',
      'Delete Lab notes now',
    ]);
    await click(button('Restore Lab notes'));
    expect(api.post).toHaveBeenCalledWith('/threads/b/restore');
  });

  it('asks before deleting one conversation now, and Cancel keeps it', async () => {
    await render();
    await click(button('Delete Budget review now'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete this conversation now?');
    expect(dialog()?.textContent).toContain('Budget review and its 4 messages');
    expect(dialog()?.textContent).toContain('This cannot be undone.');
    // Cancel comes first, so Enter straight away does not delete.
    expect(dialog()?.querySelector('button')?.textContent).toBe('Cancel');
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
    expect(titles()).toContain('Budget review');

    await click(button('Delete Budget review now'));
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (node) => node.textContent === 'Delete now',
    )!;
    await click(confirm);
    expect(api.delete).toHaveBeenCalledWith('/threads/a/permanent');
    expect(dialog()).toBeNull();
    expect(titles()).toEqual(['Lab notes']);
  });

  it('asks before emptying the trash, saying how many go', async () => {
    await render();
    await click(button('Empty trash'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Empty the trash of 2 conversations?');
    expect(dialog()?.textContent).toContain('All 2 conversations in the trash');
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (node) => node.textContent === 'Empty trash',
    )!;
    await click(confirm);
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/threads/trash');
    expect(document.body.textContent).toContain('Trash is empty.');
    expect(findButton('Empty trash')).toBeUndefined();
  });
});
