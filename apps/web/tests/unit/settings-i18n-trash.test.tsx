// @vitest-environment happy-dom
import type { TrashedThread } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tWithNodes, tWithUserText } from '../../src/components/settings/user-text';
import { translate } from '../../src/lib/i18n';
import { activateLocale } from '../../src/lib/i18n/state';
import { SettingsHistoryPage } from '../../src/routes/settings/history';
import { button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';
import { preloadCatalogs } from './i18n-test-utils';

/**
 * The trash in Spanish and Arabic (v0.14, #397): the destructive confirmations
 * say the same thing in all three languages (permanent, cannot be undone), the
 * counts take the language's plural forms, and a conversation title is isolated
 * from the sentence around it.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const DAY = 86_400_000;
const trashed = (id: string, title: string, messageCount: number): TrashedThread =>
  ({
    id,
    title,
    messageCount,
    deletedAt: new Date(Date.now() - DAY).toISOString(),
    purgeAt: new Date(Date.now() + 29 * DAY).toISOString(),
    deletedReason: 'user',
  }) as TrashedThread;

let root: Root | undefined;

beforeAll(preloadCatalogs);
beforeEach(() => {
  const trash = [trashed('a', 'Budget review', 4), trashed('b', 'Lab notes', 1)];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/threads/trash') return { threads: trash };
    if (path === '/me')
      return { user: { id: 'u1', name: 'Ada', role: 'user' }, preferences: {}, features: {} };
    if (path === '/projects') return { projects: [] };
    if (path === '/me/imports') return { imports: [] };
    if (path.startsWith('/threads?')) return { threads: [], nextCursor: null };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  await activateLocale('en');
});

async function openTrash() {
  ({ root } = await renderAdmin(<SettingsHistoryPage />, { path: '/settings/history' }));
  const tab = document.querySelector<HTMLElement>('[role="tab"]:last-of-type');
  await click(tab as HTMLElement);
}

describe('Settings → History → Trash in other languages', () => {
  it('asks before emptying the trash, in Spanish, and keeps the titles as they are', async () => {
    await activateLocale('es');
    await openTrash();
    expect(document.body.textContent).toContain('Budget review');
    await click(button('Vaciar la papelera'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      '¿Vaciar la papelera de 2 conversaciones?',
    );
    expect(dialog()?.textContent).toContain('de forma permanente');
    expect(dialog()?.textContent).toContain('no se puede deshacer');
    expect(dialog()?.querySelector('button')?.textContent).toBe('Cancelar');
  });

  it('asks before emptying the trash, in Arabic, with the dual form for two conversations', async () => {
    await activateLocale('ar');
    await openTrash();
    await click(button('إفراغ سلة المهملات'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('h2')?.textContent).toContain('محادثتين');
    expect(dialog()?.textContent).toContain('نهائيًا');
    expect(dialog()?.textContent).toContain('لا يمكن التراجع عن هذا الإجراء');
  });

  it('takes the plural form of each language for the countdown', async () => {
    await activateLocale('ar');
    expect(translate('settings.trash.purgeDays', { count: 2 })).toBe('يُحذف خلال يومين');
    expect(translate('settings.trash.purgeDays', { count: 3 })).toBe('يُحذف خلال 3 أيام');
    expect(translate('settings.trash.purgeDays', { count: 11 })).toBe('يُحذف خلال 11 يومًا');
    await activateLocale('es');
    expect(translate('settings.trash.purgeDays', { count: 1 })).toBe('se elimina en 1 día');
    expect(translate('settings.trash.purgeDays', { count: 5 })).toBe('se elimina en 5 días');
  });
});

describe('sentences with somebody’s text or an element inside', () => {
  it('wraps the user text in bdi, wherever the language puts it', async () => {
    await activateLocale('ar');
    const nodes = tWithUserText(
      (key, params) => translate(key, params),
      'settings.history.restored',
      { title: 'Budget review' },
      ['title'],
    );
    const host = document.createElement('div');
    const rendered = createRoot(host);
    await act(async () => rendered.render(nodes));
    expect(host.querySelector('bdi')?.textContent).toBe('Budget review');
    expect(host.textContent).toBe('تم استرجاع «Budget review» إلى النشطة.');
    await act(async () => rendered.unmount());
  });

  it('puts an element where the message has its placeholder', async () => {
    await activateLocale('es');
    const nodes = tWithNodes(
      (key, params) => translate(key, params),
      'settings.attachments.project',
      {},
      { project: <a href="/projects/1">Plan</a> },
    );
    const host = document.createElement('div');
    const rendered = createRoot(host);
    await act(async () => rendered.render(nodes));
    expect(host.textContent).toBe('Proyecto Plan');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/projects/1');
    await act(async () => rendered.unmount());
  });
});
