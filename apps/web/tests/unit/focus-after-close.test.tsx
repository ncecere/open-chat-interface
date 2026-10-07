// @vitest-environment happy-dom
import type { MemoryState } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRoleSelect } from '../../src/components/admin/user-role-select';
import { CommandPalette } from '../../src/components/command-palette/command-palette';
import { ThreadList } from '../../src/components/layout/thread-list';
import { useCommandPalette } from '../../src/hooks/use-command-palette';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsAttachmentsPage } from '../../src/routes/settings/attachments';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import {
  button,
  cleanup,
  click,
  dialog,
  pressEscape,
  renderAdmin,
  settle,
} from './admin-test-utils';

/**
 * #128 (regression of #41): keyboard focus must not fall to <body> when the
 * command palette closes, when the admin-role confirmation (opened from a
 * Select) is cancelled, or when the row whose button had focus is deleted.
 *
 * Real Radix dialogs, Select and query cache; only the HTTP layer is a fake
 * server, whose deletions really remove the row from the next fetch.
 */
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

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

describe('the command palette', () => {
  /** The app shell's wiring: the ⌘K hook, the top bar's Search button. */
  function Shell() {
    const palette = useCommandPalette();
    // The shell's providers: New chat leaves temporary mode (#340).
    return (
      <ThemeProvider>
        <TemporaryChatProvider>
          <textarea aria-label="Message" />
          <button type="button" onClick={palette.show}>
            Search commands and conversations
          </button>
          <CommandPalette
            open={palette.open}
            onOpenChange={palette.setOpen}
            sidebarOpen
            onSidebarOpenChange={() => undefined}
          />
        </TemporaryChatProvider>
      </ThemeProvider>
    );
  }

  beforeEach(() => {
    api.get.mockImplementation(async (path: string) =>
      path === '/me'
        ? { user: { id: 'me', role: 'user' }, preferences: {}, features: {} }
        : { results: [], projects: [], threads: [] },
    );
  });

  it('returns focus to the Search button that opened it', async () => {
    ({ root } = await renderAdmin(<Shell />));
    const search = button('Search commands and conversations');
    search.focus();
    await click(search);
    expect(document.activeElement?.getAttribute('role')).toBe('combobox');
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('returns focus to the composer after ⌘K and Escape', async () => {
    ({ root } = await renderAdmin(<Shell />));
    const composer = document.querySelector<HTMLTextAreaElement>('textarea')!;
    composer.focus();
    await press('k', { metaKey: true });
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(document.activeElement).toBe(composer);
  });
});

describe("an admin's role confirmation", () => {
  beforeEach(() => {
    api.get.mockImplementation(async (path: string) =>
      path === '/me' ? { user: { id: 'me' }, preferences: {}, features: {} } : {},
    );
  });

  it('returns focus to the role selector when cancelled', async () => {
    ({ root } = await renderAdmin(
      <UserRoleSelect user={{ id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user' }} />,
    ));
    const trigger = button('Role for ada@example.test');
    trigger.focus();
    await press('Enter');
    const admin = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'Admin',
    )!;
    await act(async () => admin.focus());
    await press('Enter');
    expect(dialog()?.textContent).toContain('Make Ada an administrator?');

    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('deleting a row', () => {
  it('moves focus to the next memory, not the body', async () => {
    const entry = (id: string, content: string) => ({
      id,
      content,
      source: 'person' as const,
      threadId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let memory: MemoryState = {
      enabled: true,
      available: true,
      entries: [entry('m1', 'Teaches chemistry'), entry('m2', 'Prefers metric units')],
      limits: { maxEntries: 200, maxChars: 500 },
    };
    api.get.mockImplementation(async () => memory);
    api.delete.mockImplementation(async (path: string) => {
      memory = { ...memory, entries: memory.entries.filter((e) => !path.endsWith(e.id)) };
      return { ok: true };
    });
    ({ root } = await renderAdmin(<SettingsMemoryPage />));

    const ask = button('Delete memory: Teaches chemistry');
    ask.focus();
    await click(ask);
    // Asking swaps the buttons; focus stays in the row, on Cancel.
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(button('Delete memory: Teaches chemistry'));

    await click(button('Delete memory: Teaches chemistry'));
    const confirm = button('Confirm: delete memory: Teaches chemistry');
    confirm.focus();
    await click(confirm);
    await settle();
    expect(document.body.textContent).not.toContain('Teaches chemistry');
    expect(document.activeElement).toBe(button('Edit memory: Prefers metric units'));
  });

  it('moves focus to the next attachment after the confirmation closes', async () => {
    const file = (id: string, filename: string) => ({
      id,
      filename,
      mimeType: 'text/plain',
      sizeBytes: 2048,
      url: `/api/attachments/${id}/content`,
      thumbnailUrl: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      project: null,
    });
    let files = [file('a1', 'first.txt'), file('a2', 'second.txt')];
    api.get.mockImplementation(async (path: string) =>
      path === '/attachments'
        ? { attachments: files }
        : {
            liveBytes: 0,
            liveFileCount: 0,
            pendingBytes: 0,
            pendingFileCount: 0,
            artifactBytes: 0,
            breakdown: {
              chatFiles: { bytes: 0, count: 0 },
              projectFiles: { bytes: 0, count: 0 },
              artifacts: { bytes: 0, count: 0 },
            },
            maxTotalBytes: null,
            maxFileCount: null,
            maxFileBytes: null,
          },
    );
    api.delete.mockImplementation(async (path: string) => {
      files = files.filter((candidate) => !path.endsWith(candidate.id));
      return { ok: true };
    });
    ({ root } = await renderAdmin(<SettingsAttachmentsPage />));

    const remove = button('Delete first.txt');
    remove.focus();
    await click(remove);
    expect(dialog()?.textContent).toContain('Delete first.txt?');
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!);
    await settle();
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain('first.txt');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Select second.txt');
  });

  it('moves focus to the next conversation when one is archived', async () => {
    const now = new Date().toISOString();
    let threads = ['First', 'Second'].map((title, index) => ({
      id: `t${index}`,
      title,
      pinned: false,
      archived: false,
      parentThreadId: null,
      projectId: null,
      updatedAt: now,
      lastMessageAt: now,
    }));
    api.get.mockImplementation(async (path: string) =>
      path.startsWith('/threads')
        ? { threads }
        : path === '/me'
          ? { user: { id: 'me', role: 'user' }, preferences: {}, features: { projects: false } }
          : { projects: [] },
    );
    api.patch.mockImplementation(async (path: string) => {
      threads = threads.filter((candidate) => !path.endsWith(candidate.id));
      return {};
    });
    ({ root } = await renderAdmin(<ThreadList />));
    const archive = button('Archive conversation: First');
    archive.focus();
    await click(archive);
    await settle();
    expect(document.body.textContent).not.toContain('First');
    expect(document.activeElement?.textContent).toBe('Second');
  });
});
