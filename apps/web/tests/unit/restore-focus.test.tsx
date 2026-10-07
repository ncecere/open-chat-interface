// @vitest-environment happy-dom
import type { MemoryState, TrashedThread } from '@oci/shared';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import type { PendingAttachment } from '../../src/hooks/use-attachments';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsHistoryPage } from '../../src/routes/settings/history';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { button, cleanup, click, renderAdmin, settle } from './admin-test-utils';

/**
 * #250: focus fell to the body after Restore (Trash and Archived), after
 * opening or cancelling Memory's "Delete all…", and after removing an
 * attachment chip; and Restore said nothing. The real pages, query cache,
 * Sonner toaster and focus helpers; only the server is a stub, stateful as
 * the real one is, so restored rows really leave the list on refetch.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const NOW = new Date().toISOString();
const summary = (id: string, title: string) => ({
  id,
  title,
  pinned: false,
  archived: true,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId: null,
  lastMessageAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});
const trashed = (id: string, title: string): TrashedThread => ({
  id,
  title,
  messageCount: 2,
  deletedAt: NOW,
  deletedReason: 'user',
  purgeAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
});

let trash: TrashedThread[];
let archived: ReturnType<typeof summary>[];
let memory: MemoryState;
let root: Root | undefined;
beforeEach(() => {
  trash = [trashed('a', 'Budget review'), trashed('b', 'Lab notes')];
  archived = [summary('x', 'Old plan'), summary('y', 'Reading list')];
  memory = {
    enabled: true,
    available: true,
    entries: [
      {
        id: 'm1',
        content: 'Teaches chemistry',
        source: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    limits: { maxEntries: 50, maxChars: 500 },
  } as unknown as MemoryState;
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/threads/trash') return { threads: trash };
    if (path === '/memory') return memory;
    if (path === '/me')
      return { user: { id: 'u1', name: 'Ada', role: 'user' }, preferences: {}, features: {} };
    if (path === '/projects') return { projects: [] };
    if (path === '/me/imports') return { imports: [] };
    if (path.startsWith('/threads?'))
      return { threads: path.includes('archived=true') ? archived : [], nextCursor: null };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockImplementation(async (path: string) => {
    const id = path.split('/')[2];
    trash = trash.filter((thread) => thread.id !== id);
    return { ok: true };
  });
  api.patch.mockReset().mockImplementation(async (path: string) => {
    const id = path.split('/')[2];
    archived = archived.filter((thread) => thread.id !== id);
    return {};
  });
  api.delete.mockReset().mockImplementation(async () => {
    memory = { ...memory, entries: [] };
    return { deleted: 1 };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** Keyboard activation: focus the control, then press it. */
async function press(control: HTMLElement) {
  control.focus();
  expect(document.activeElement).toBe(control);
  await click(control);
  await settle();
}

async function openTab(name: string) {
  ({ root } = await renderAdmin(
    <>
      <SettingsHistoryPage />
      <Toaster />
    </>,
    { path: '/settings/history' },
  ));
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (node) => node.textContent === name,
    )!,
  );
}

describe('Restore (#250)', () => {
  it('in Trash, says so and moves focus to the next row', async () => {
    await openTab('Trash');
    await press(button('Restore Budget review'));
    expect(document.querySelector('[aria-label="Restore Budget review"]')).toBeNull();
    expect(document.activeElement).toBe(button('Restore Lab notes'));
    expect(document.body.textContent).toContain('Restored “Budget review” from the trash.');

    // The last one: the page's heading.
    await press(button('Restore Lab notes'));
    expect(document.body.textContent).toContain('Trash is empty.');
    expect(document.activeElement?.textContent).toBe('History');
  });

  it('in Archived, says so and moves focus to the next row', async () => {
    await openTab('Archived');
    await press(button('Restore Old plan'));
    expect(document.querySelector('[aria-label="Select Old plan"]')).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Select Reading list"]'),
    );
    expect(document.body.textContent).toContain('Restored “Old plan” to Active.');
  });
});

describe('Memory › Delete all (#250)', () => {
  it('keeps focus on the confirmation, Cancel and the heading', async () => {
    ({ root } = await renderAdmin(<SettingsMemoryPage />, { path: '/settings/memory' }));
    await press(button('Delete all…'));
    expect(document.activeElement).toBe(button('Cancel'));

    await press(button('Cancel'));
    expect(document.activeElement).toBe(button('Delete all…'));

    await press(button('Delete all…'));
    await press(button('Delete all memories'));
    expect(document.body.textContent).toContain('Nothing is remembered about you.');
    expect(document.activeElement?.id).toBe('memory-list-title');
  });
});

describe('Removing an attachment chip (#250)', () => {
  const file = (localId: string, filename: string) =>
    ({
      localId,
      filename,
      mimeType: 'text/plain',
      sizeBytes: 10,
      status: 'ready',
    }) as PendingAttachment;

  function Harness() {
    const [items, setItems] = useState([file('1', 'notes.txt'), file('2', 'data.csv')]);
    return (
      <ThemeProvider>
        <Composer
          value=""
          onChange={() => undefined}
          onSubmit={() => undefined}
          models={[]}
          selectedModel={undefined}
          onSelectModel={() => undefined}
          attachments={items}
          onRemoveAttachment={(id) =>
            setItems((current) => current.filter((item) => item.localId !== id))
          }
        />
      </ThemeProvider>
    );
  }

  it('moves focus to the next chip, then the message box', async () => {
    ({ root } = await renderAdmin(<Harness />));
    await press(button('Remove notes.txt'));
    expect(document.activeElement).toBe(button('Remove data.csv'));
    await press(button('Remove data.csv'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Message input');
  });
});

// Keeps act() quiet about the Toaster's own timers between tests.
afterEach(async () => {
  await act(async () => undefined);
});
