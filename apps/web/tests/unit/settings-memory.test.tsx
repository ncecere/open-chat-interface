// @vitest-environment happy-dom
import type { MemoryState } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { alerts, cleanup, click, findButton, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const entry = (id: string, content: string, source: 'tool' | 'person' = 'person') => ({
  id,
  content,
  source,
  threadId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

let root: Root | undefined;
let memory: MemoryState;
beforeEach(() => {
  memory = {
    enabled: true,
    available: true,
    entries: [entry('m2', 'Prefers metric units', 'tool'), entry('m1', 'Teaches chemistry')],
    limits: { maxEntries: 200, maxChars: 500 },
  };
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/memory') return memory;
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ memory: entry('m3', 'New'), created: true });
  api.put.mockReset().mockImplementation(async (_path: string, body: { enabled: boolean }) => {
    memory = { ...memory, enabled: body.enabled };
    return memory;
  });
  api.patch.mockReset().mockResolvedValue({ memory: entry('m1', 'Edited') });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsMemoryPage />, { path: '/settings/memory' }));
};

/** Sets a textarea's value the way React notices. */
async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Settings → Memory', () => {
  it('lists every memory newest first with where it came from', async () => {
    await render();
    const items = [...document.querySelectorAll('[data-testid="memory-entry"]')];
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Prefers metric units',
      'Teaches chemistry',
    ]);
    expect(items[0]?.textContent).toContain('Saved by a model');
    expect(items[1]?.textContent).toContain('Added by you');
    expect(document.body.textContent).toContain('2 of 200');
  });

  it('switches memory off and on', async () => {
    await render();
    const toggle = document.getElementById('memory-enabled') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    expect(api.put).toHaveBeenCalledWith('/memory/settings', { enabled: false });
  });

  it('adds a memory and refuses one that is too long', async () => {
    await render();
    const textarea = document.getElementById('memory-new') as HTMLTextAreaElement;
    await type(textarea, 'x'.repeat(501));
    expect(findButton('Add')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('501/500');
    await type(textarea, 'Likes  tea');
    await click(findButton('Add')!);
    expect(api.post).toHaveBeenCalledWith('/memory', { content: 'Likes  tea' });
  });

  it('says in words that a memory is too long, tied to the field and to Add (#310)', async () => {
    await render();
    const textarea = document.getElementById('memory-new') as HTMLTextAreaElement;
    // The limit is heard with the field before anything is wrong.
    expect(textarea.getAttribute('aria-describedby')).toBe('memory-new-count');
    expect(document.getElementById('memory-new-count')?.textContent).toBe('0/500 characters');
    expect(textarea.getAttribute('aria-invalid')).toBeNull();

    await type(textarea, 'x'.repeat(520));
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('memory-new-count memory-new-error');
    const error = document.getElementById('memory-new-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toBe(
      'A memory can be at most 500 characters; this one has 520. Shorten it to save it.',
    );
    const add = findButton('Add')!;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('aria-describedby')).toBe('memory-new-error');

    await type(textarea, 'Likes tea');
    expect(document.getElementById('memory-new-error')).toBeNull();
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
  });

  it('edits and deletes one memory', async () => {
    await render();
    await click(findButton('Edit memory: Teaches chemistry')!);
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-entry"] textarea',
    )!;
    await type(editor, 'Teaches organic chemistry');
    await click(findButton('Save')!);
    expect(api.patch).toHaveBeenCalledWith('/memory/m1', { content: 'Teaches organic chemistry' });

    await click(findButton('Delete memory: Prefers metric units')!);
    // It asks first, as Delete all does (#101).
    expect(api.delete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Delete this memory?');
    await click(findButton('Confirm: delete memory: Prefers metric units')!);
    expect(api.delete).toHaveBeenCalledWith('/memory/m2');
  });

  // Edit and the form replace each other, removing the control that had
  // focus, so focus fell to the body (as Edit name did, #270).
  it('puts focus in the editor on Edit, and back on Edit after Cancel, Escape or Save', async () => {
    await render();
    const edit = () => findButton('Edit memory: Teaches chemistry')!;
    const editor = () =>
      document.querySelector<HTMLTextAreaElement>('[data-testid="memory-entry"] textarea');
    edit().focus();
    await click(edit());
    expect(document.activeElement).toBe(editor());

    findButton('Cancel')!.focus();
    await click(findButton('Cancel')!);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(edit());

    await click(edit());
    await act(async () => {
      editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(edit());

    await click(edit());
    await type(editor()!, 'Teaches organic chemistry');
    findButton('Save')!.focus();
    await click(findButton('Save')!);
    expect(api.patch).toHaveBeenCalledWith('/memory/m1', { content: 'Teaches organic chemistry' });
    expect(editor()).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Edit memory: /);
  });

  it('asks before deleting everything', async () => {
    await render();
    await click(findButton('Delete all…')!);
    expect(document.body.textContent).toContain('Delete all 2 memories? This cannot be undone.');
    expect(api.delete).not.toHaveBeenCalled();
    await click(findButton('Delete all memories')!);
    expect(api.delete).toHaveBeenCalledWith('/memory');
  });

  it('asks about one memory without "all 1 memory" (#254)', async () => {
    memory = { ...memory, entries: [memory.entries[0]!] };
    await render();
    await click(findButton('Delete all…')!);
    expect(document.body.textContent).toContain('Delete your one memory? This cannot be undone.');
    expect(document.body.textContent).not.toContain('all 1');
  });

  it('explains when memory is not offered, keeping review and deletion', async () => {
    memory = { ...memory, enabled: false, available: false };
    await render();
    expect(document.querySelector('[role="note"]')?.textContent).toContain(
      'Memory is not available to you',
    );
    expect((document.getElementById('memory-enabled') as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById('memory-new')).toBeNull();
    expect(findButton('Edit memory: Teaches chemistry')).toBeUndefined();
    expect(findButton('Delete memory: Teaches chemistry')).toBeDefined();
  });

  it('says when nothing is remembered and shows a refused change', async () => {
    memory = { ...memory, entries: [] };
    api.post.mockRejectedValueOnce(
      new (await import('../../src/lib/api-client')).ApiError(
        422,
        'VALIDATION_FAILED',
        'You have reached the limit of 200 memories.',
      ),
    );
    await render();
    expect(document.body.textContent).toContain('Nothing is remembered about you.');
    expect(findButton('Delete all…')).toBeUndefined();
    await type(document.getElementById('memory-new') as HTMLTextAreaElement, 'One more');
    await click(findButton('Add')!);
    expect(alerts()).toContain('You have reached the limit of 200 memories.');
  });
});
