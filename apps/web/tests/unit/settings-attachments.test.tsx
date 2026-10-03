// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAttachmentsPage } from '../../src/routes/settings/attachments';
import { button, cleanup, click, renderAdmin } from './admin-test-utils';

/**
 * Settings → Attachments (v0.9.1): project files are listed with their
 * project and managed there, storage is broken down by kind, the deletion
 * text says what actually happens, and an empty list is one line.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const file = (id: string, filename: string, project: { id: string; name: string } | null) => ({
  id,
  filename,
  mimeType: 'text/plain',
  sizeBytes: 2048,
  url: `/api/attachments/${id}/content`,
  thumbnailUrl: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  project,
});

let files: ReturnType<typeof file>[];
let root: Root | undefined;
beforeEach(() => {
  files = [
    file('a1', 'chat-notes.txt', null),
    file('a2', 'reading.txt', { id: 'p1', name: 'Reading list' }),
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/attachments') return { attachments: files };
    if (path === '/attachments/usage')
      return {
        liveBytes: 300 * 1024,
        liveFileCount: 2,
        pendingBytes: 0,
        pendingFileCount: 0,
        artifactBytes: 100 * 1024,
        breakdown: {
          chatFiles: { bytes: 2048, count: 1 },
          projectFiles: { bytes: 198 * 1024, count: 1 },
          artifacts: { bytes: 100 * 1024, count: 3 },
        },
        maxTotalBytes: null,
        maxFileCount: null,
        maxFileBytes: null,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsAttachmentsPage />, { path: '/settings/attachments' }));
};

describe('Settings → Attachments', () => {
  it('says what deleting does, without the old warning', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      'Deleting a chat file removes it from its conversations, which stay, and models can no longer read it there.',
    );
    expect(text).not.toContain('unexpected behavior');
  });

  it('breaks storage down into chat files, project files and artifacts', async () => {
    await render();
    const breakdown = document.querySelector('dl[aria-label="Storage by kind"]')!;
    const entries = [...breakdown.querySelectorAll('div')].map((row) => row.textContent);
    expect(entries).toEqual([
      'Chat files2 KB · 1 file',
      'Project files198 KB · 1 file',
      'Artifacts100 KB · 3 artifacts',
    ]);
    expect(document.body.textContent).toContain('300 KB · 2 files');
  });

  it('lists project files with their project, to be managed there', async () => {
    await render();
    const projectLink = document.querySelector<HTMLAnchorElement>(
      'a[href="/projects/p1?tab=files"]',
    );
    expect(projectLink?.textContent).toBe('Reading list');
    expect(
      document.querySelector('[aria-label="Manage reading.txt in Reading list"]'),
    ).not.toBeNull();
    // Not selectable or deletable here.
    expect(document.querySelector('[aria-label="Select reading.txt"]')).toBeNull();
    expect(document.querySelector('[aria-label="Delete reading.txt"]')).toBeNull();
    expect(document.querySelector('[aria-label="Select chat-notes.txt"]')).not.toBeNull();
  });

  it('selects and deletes only chat files', async () => {
    await render();
    await click(document.querySelector('[aria-label="Select all visible attachments"]')!);
    await click(button('Delete (1)'));
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/attachments/a1');
  });

  it('shows an empty list as one compact line', async () => {
    files = [];
    await render();
    expect(document.body.textContent).toContain('No attachments yet');
    expect(document.body.textContent).toContain(
      'Files uploaded in chats and to projects will appear here.',
    );
    // No table header, and no tall empty box.
    expect(document.querySelector('[aria-label="Select all visible attachments"]')).toBeNull();
    expect(document.querySelector('.sm\\:min-h-\\[32rem\\]')).toBeNull();
  });
});
