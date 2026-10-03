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
    expect(api.delete).toHaveBeenCalledWith('/memory/m2');
  });

  it('asks before deleting everything', async () => {
    await render();
    await click(findButton('Delete all…')!);
    expect(document.body.textContent).toContain('Delete all 2 memories? This cannot be undone.');
    expect(api.delete).not.toHaveBeenCalled();
    await click(findButton('Delete all memories')!);
    expect(api.delete).toHaveBeenCalledWith('/memory');
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
