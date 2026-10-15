// @vitest-environment happy-dom
import type { ProjectAccessInfo, ProjectFile, ProjectSummary, ThreadSummary } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ProjectPage } from '../../src/routes/projects/project';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  dismissToasts,
  findButton,
  renderAdmin,
} from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const PROJECT: ProjectSummary = {
  id: 'project-1',
  name: 'Thesis',
  instructions: 'Cite sources.',
  fileCount: 2,
  threadCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const FILES: ProjectFile[] = [
  {
    id: 'file-1',
    filename: 'outline.md',
    mimeType: 'text/markdown',
    sizeBytes: 2048,
    url: '/api/attachments/file-1/content',
    thumbnailUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    index: { status: 'indexed', passages: 3 },
    addedBy: 'Olive Owner',
    addedByMe: false,
  },
  {
    id: 'file-2',
    filename: 'mine.txt',
    mimeType: 'text/plain',
    sizeBytes: 100,
    url: '/api/attachments/file-2/content',
    thumbnailUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    index: { status: 'no-text', passages: 0 },
    addedBy: 'Pat',
    addedByMe: true,
  },
];
const THREAD: ThreadSummary = {
  id: 'thread-1',
  title: 'My own chat',
  pinned: false,
  archived: false,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId: 'project-1',
  lastMessageAt: '2026-01-03T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
};

let project: ProjectSummary;
let accessInfo: ProjectAccessInfo;
let root: Root | undefined;

function setAccess(access: 'owner' | 'editor' | 'viewer', canLeave = true) {
  project =
    access === 'owner' ? { ...PROJECT, access } : { ...PROJECT, access, ownerName: 'Olive Owner' };
  accessInfo = {
    access,
    ownerName: 'Olive Owner',
    personShares: 2,
    groupShares: 1,
    canLeave: access !== 'owner' && canLeave,
  };
}

beforeEach(() => {
  setAccess('owner');
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return { user: { id: 'me', name: 'Pat' }, features: { projects: true, attachments: true } };
    if (path === '/projects/project-1') return { project };
    if (path === '/projects/project-1/access') return accessInfo;
    if (path === '/projects/project-1/files') return { files: FILES };
    if (path === '/threads?projectId=project-1') return { threads: [THREAD] };
    if (path === '/projects/project-1/shares') return { shares: [] };
    if (path === '/groups/mine') return { groups: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ project: PROJECT });
  api.post.mockReset().mockResolvedValue({ ok: true, detachedThreads: 0, movedFiles: 0 });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function render(tab?: string) {
  ({ root } = await renderAdmin(
    <TemporaryChatProvider>
      <ProjectPage projectId="project-1" />
      <Toaster />
    </TemporaryChatProvider>,
    { path: tab ? `/projects/project-1?tab=${tab}` : '/projects/project-1' },
  ));
}

function textarea(): HTMLTextAreaElement {
  const found = document.querySelector('textarea');
  if (!found) throw new Error('No textarea');
  return found;
}

function tab(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No tab named ${name}`);
  return found;
}

function has(name: string): boolean {
  return findButton(name) !== undefined;
}

type Access = 'owner' | 'editor' | 'viewer';
const ACCESS_LEVELS: Access[] = ['owner', 'editor', 'viewer'];

describe('each access level sees its own controls (the access matrix)', () => {
  // [access, header: Share, files: Upload files, files: Remove, instructions: Save, instructions read-only, settings: rename, delete, transfer, leave]
  it.each([
    [
      'owner',
      {
        share: true,
        save: true,
        readOnly: false,
        upload: true,
        remove: true,
        rename: true,
        remove_project: true,
        transfer: true,
        leave: false,
      },
    ],
    [
      'editor',
      {
        share: false,
        save: true,
        readOnly: false,
        upload: true,
        remove: true,
        rename: false,
        remove_project: false,
        transfer: false,
        leave: true,
      },
    ],
    [
      'viewer',
      {
        share: false,
        save: false,
        readOnly: true,
        upload: false,
        remove: false,
        rename: false,
        remove_project: false,
        transfer: false,
        leave: true,
      },
    ],
  ] as const)('%s', async (access, expected) => {
    setAccess(access);

    await render();
    expect(has('Share'), 'Share in the header').toBe(expected.share);
    // Everyone can start their own conversation in it.
    expect(
      [...document.querySelectorAll('a')].some(
        (link) => link.textContent?.trim() === 'New chat in project',
      ),
    ).toBe(true);

    await click(tab('Instructions'));
    expect(textarea().readOnly, 'instructions are read-only').toBe(expected.readOnly);
    expect(textarea().value).toBe('Cite sources.');
    expect(has('Save changes'), 'Save changes').toBe(expected.save);

    await click(tab('Files'));
    expect(has('Upload files'), 'Upload files').toBe(expected.upload);
    expect(has('Remove outline.md'), 'Remove').toBe(expected.remove);
    expect(has('Remove mine.txt'), 'Remove own file').toBe(expected.remove);
    // Everyone can open (download) a file.
    expect(document.querySelector('a[href="/api/attachments/file-1/content"]')).not.toBeNull();

    await click(tab('Settings'));
    expect(
      [...document.querySelectorAll('label')].some(
        (label) => label.textContent?.trim() === 'Project name',
      ),
      'rename',
    ).toBe(expected.rename);
    expect(has('Delete project'), 'Delete project').toBe(expected.remove_project);
    expect(has('Transfer project…'), 'Transfer').toBe(expected.transfer);
    expect(has('Leave project'), 'Leave').toBe(expected.leave);
  });

  it.each(ACCESS_LEVELS.filter((a) => a !== 'owner'))(
    'shows a %s their access level and who shared it',
    async (access) => {
      setAccess(access);
      await render();
      const header = document.querySelector('header')!;
      expect(header.textContent).toContain(access === 'editor' ? 'Editor' : 'Viewer');
      expect(header.textContent).toContain('Shared by Olive Owner');
    },
  );

  it('shows an owner no access badge (nothing was shared with them)', async () => {
    await render();
    expect(document.querySelector('header')!.textContent).not.toContain('Shared by');
  });

  it('says on the conversations tab that the person’s own conversations stay private', async () => {
    setAccess('viewer');
    await render();
    expect(document.body.textContent).toContain(
      'Only you can see your conversations in this project.',
    );
  });
});

describe('files say who added them', () => {
  it('names the person, or "you", on each file and never an email', async () => {
    setAccess('viewer');
    await render('files');
    const rows = [...document.querySelectorAll('[aria-label="Project files"] li')];
    expect(rows[0]?.textContent).toContain('Added by Olive Owner');
    expect(rows[1]?.textContent).toContain('Added by you');
    expect(document.body.textContent).not.toContain('@');
  });

  it('says a deleted account added a file without inventing a name', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me')
        return { user: { id: 'me', name: 'Pat' }, features: { projects: true, attachments: true } };
      if (path === '/projects/project-1') return { project };
      if (path === '/projects/project-1/files')
        return { files: [{ ...FILES[0], addedBy: null, addedByMe: false }] };
      throw new Error(`Unexpected GET ${path}`);
    });
    await render('files');
    expect(document.querySelector('[aria-label="Project files"]')?.textContent).toContain(
      'Added by a deleted account',
    );
  });

  it('explains to a viewer that only owners and editors change files', async () => {
    setAccess('viewer');
    await render('files');
    expect(document.body.textContent).toContain(
      'Only the owner and editors can add or remove files.',
    );
    expect(document.body.textContent).not.toContain('Files count toward your storage');
  });
});

describe('leaving a shared project', () => {
  it('asks first, says what happens, then leaves and goes home', async () => {
    setAccess('viewer');
    await render('settings');
    await click(button('Leave project'));
    const confirm = dialog()!;
    expect(confirm.textContent).toContain('Leave “Thesis”?');
    expect(confirm.textContent).toContain('It disappears from your lists');
    expect(confirm.textContent).toContain('Your conversations in it are kept');
    expect(api.post).not.toHaveBeenCalled();

    const leave = [...confirm.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Leave project',
    )!;
    await click(leave);
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/projects/project-1/leave');
    await dismissToasts();
  });

  it('explains a share through a group instead of offering Leave', async () => {
    setAccess('editor', false);
    await render('settings');
    expect(has('Leave project')).toBe(false);
    expect(document.body.textContent).toContain('You have access through a group');
    expect(document.body.textContent).toContain('ask the owner or a group manager');
  });

  it('shows the server’s refusal when leaving was refused after all', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'You have access through a group.', {
        reason: 'leave_via_group',
      }),
    );
    setAccess('viewer');
    await render('settings');
    await click(button('Leave project'));
    const leave = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Leave project',
    )!;
    await click(leave);
    expect(alerts(dialog()!).join(' ')).toContain('through a group');
  });

  it('counts only: the access section names the owner and how many it is shared with', async () => {
    setAccess('viewer');
    await render('settings');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Olive Owner owns this project');
    expect(text).toContain('shared with 2 people and 1 group');
  });
});

describe('when access ends', () => {
  it('says “You no longer have access” instead of failing when the project vanishes mid-session', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    setAccess('viewer');
    await render('files');
    expect(document.body.textContent).toContain('outline.md');

    // The owner removes the share; the person's next request says 404.
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me')
        return { user: { id: 'me', name: 'Pat' }, features: { projects: true, attachments: true } };
      throw new ApiError(404, 'NOT_FOUND', 'Project not found');
    });
    // The next request the page makes (its conversations) says 404: the project is read again.
    await click(tab('Conversations'));
    await vi.waitFor(() =>
      expect(document.querySelector('h1')?.textContent).toBe('You no longer have access'),
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Your own conversations that were in it are kept');
    expect([...document.querySelectorAll('a')].map((a) => a.textContent)).toContain('New chat');
  });

  it('reads a first-load 404 as not found or no access, without guessing which', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me')
        return { user: { id: 'me', name: 'Pat' }, features: { projects: true, attachments: true } };
      throw new ApiError(404, 'NOT_FOUND', 'Project not found');
    });
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Project not found');
    expect(document.body.textContent).toContain(
      'does not exist, was deleted, or you no longer have access',
    );
  });
});

describe('deleting a project that is shared', () => {
  it('says how many people and groups lose access and what becomes of their conversations', async () => {
    await render('settings');
    await click(button('Delete project'));
    expect(api.get).toHaveBeenCalledWith('/projects/project-1/access');
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('It is shared with 2 people and 1 group.');
    expect(text).toContain(
      'They lose access, and their own conversations in it are kept but leave the project.',
    );
    // The owner's own counts are still said.
    expect(text).toContain('Its conversation is kept and leaves the project.');
  });

  it('says nothing about sharing for a project nobody shares', async () => {
    accessInfo = { ...accessInfo, personShares: 0, groupShares: 0 };
    await render('settings');
    await click(button('Delete project'));
    expect(dialog()!.textContent).not.toContain('shared with');
  });

  it('still lets the owner delete when the share counts could not be read', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    const base = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (path: string) => {
      if (path === '/projects/project-1/access') throw new ApiError(500, 'INTERNAL_ERROR', 'Boom');
      return base(path);
    });
    await render('settings');
    await click(button('Delete project'));
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Delete project',
    )!;
    expect(confirm.disabled).toBe(false);
  });
});
