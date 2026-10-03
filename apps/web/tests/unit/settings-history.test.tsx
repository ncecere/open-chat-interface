// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_SEARCH_DEBOUNCE_MS, SettingsHistoryPage } from '../../src/routes/settings/history';
import { button, cleanup, click, dialog, renderAdmin, settle } from './admin-test-utils';

/**
 * Settings → History (v0.9.1): conversations a page at a time with Load
 * more, a title search, linked titles beside their own checkboxes, a
 * tri-state Select all, project labels, one toast for a bulk change, and
 * export/import as buttons at the top.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const thread = (id: string, title: string, projectId: string | null = null) => ({
  id,
  title,
  pinned: false,
  archived: false,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId,
  lastMessageAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

let root: Root | undefined;
let historyRequests: URLSearchParams[];
beforeEach(() => {
  historyRequests = [];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user' },
        preferences: {},
        features: { projects: true },
      };
    if (path === '/projects') return { projects: [{ id: 'p1', name: 'Thesis' }] };
    if (path === '/me/imports') return { imports: [] };
    if (path === '/threads/trash') return { threads: [] };
    if (path.startsWith('/threads?')) {
      const params = new URLSearchParams(path.slice('/threads?'.length));
      historyRequests.push(params);
      if (params.get('search'))
        return { threads: [thread('s1', 'Budget review')], nextCursor: null };
      if (params.get('archived'))
        return { threads: [{ ...thread('z1', 'Old plan'), archived: true }], nextCursor: null };
      if (params.get('before') === 'cursor-1')
        return { threads: [thread('t3', 'Third conversation')], nextCursor: null };
      return {
        threads: [thread('t1', 'Lab report', 'p1'), thread('t2', 'Holiday plans')],
        nextCursor: 'cursor-1',
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({});
  api.delete.mockReset().mockResolvedValue({ ok: true });
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsHistoryPage />, { path: '/settings/history' }));
};

const rows = () => [...document.querySelectorAll('ul[aria-label="Conversations"] > li')];
const checkbox = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const selectAll = () =>
  [...document.querySelectorAll('label')]
    .find((label) => label.textContent === 'Select all')!
    .querySelector('input')!;

describe('Settings → History', () => {
  it('is called History and puts export and import at the top', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('History');
    const exportButton = button('Export all conversations');
    const tablist = document.querySelector('[role="tablist"]')!;
    expect(
      exportButton.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(button('Import from ChatGPT or Claude')).toBeDefined();
    expect(document.body.textContent).not.toContain('Your data');

    await click(exportButton);
    const link = dialog()?.querySelector<HTMLAnchorElement>('a[href="/api/me/export"]');
    expect(link?.hasAttribute('download')).toBe(true);
  });

  it('switches Active, Archived and Trash with the shared tabs', async () => {
    await render();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Active', 'Archived', 'Trash']);
    await click([...document.querySelectorAll<HTMLElement>('[role="tab"]')][1]!);
    expect(rows().map((row) => row.querySelector('a')?.textContent)).toEqual(['Old plan']);
    expect(historyRequests.at(-1)?.get('archived')).toBe('true');
    await click(button('Restore Old plan'));
    expect(api.patch).toHaveBeenCalledWith('/threads/z1', { archived: false });
  });

  it('links each title to its conversation, beside a checkbox of its own', async () => {
    await render();
    const [first] = rows();
    const link = first!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/chat/t1');
    const box = checkbox('Select Lab report');
    // Not nested: the checkbox is neither in the link nor in a label around it.
    expect(link.contains(box)).toBe(false);
    expect(box.closest('label')).toBeNull();
    expect(first!.textContent).toContain('Project: Thesis');
    expect(rows()[1]?.textContent).not.toContain('Project:');
  });

  it('selects all with a tri-state checkbox', async () => {
    await render();
    await click(checkbox('Select Lab report'));
    expect(selectAll().indeterminate).toBe(true);
    expect(selectAll().getAttribute('aria-checked')).toBe('mixed');
    await click(selectAll());
    expect(selectAll().checked).toBe(true);
    expect(checkbox('Select Holiday plans').checked).toBe(true);
    expect(document.body.textContent).toContain('2 selected');
    await click(selectAll());
    expect(checkbox('Select Lab report').checked).toBe(false);
  });

  it('loads more after the first page', async () => {
    await render();
    expect(historyRequests[0]?.get('view')).toBe('history');
    expect(rows()).toHaveLength(2);
    await click(button('Load more'));
    expect(historyRequests.at(-1)?.get('before')).toBe('cursor-1');
    expect(rows().map((row) => row.querySelector('a')?.textContent)).toEqual([
      'Lab report',
      'Holiday plans',
      'Third conversation',
    ]);
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'Load more'),
    ).toBe(false);
  });

  it('searches titles on the server once typing pauses', async () => {
    await render();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      'Search conversation titles',
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'budget');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(historyRequests.some((params) => params.get('search'))).toBe(false);
    await act(() => new Promise((resolve) => setTimeout(resolve, HISTORY_SEARCH_DEBOUNCE_MS + 50)));
    await settle();
    expect(historyRequests.at(-1)?.get('search')).toBe('budget');
    expect(rows().map((row) => row.querySelector('a')?.textContent)).toEqual(['Budget review']);
  });

  it('moves selected conversations to the trash with one toast', async () => {
    await render();
    await click(selectAll());
    await click(button('Delete'));
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.delete).toHaveBeenCalledWith('/threads/t1');
    expect(api.delete).toHaveBeenCalledWith('/threads/t2');
    expect(toast.success).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Moved 2 conversations to the trash.');
  });

  it('reports partial failures once', async () => {
    api.delete.mockImplementation(async (path: string) => {
      if (path === '/threads/t2') throw new Error('nope');
      return { ok: true };
    });
    await render();
    await click(selectAll());
    await click(button('Delete'));
    expect(toast.success).toHaveBeenCalledWith('Moved 1 conversation to the trash.');
    expect(toast.error).toHaveBeenCalledWith('1 conversation could not be changed. Try again.');
  });
});
