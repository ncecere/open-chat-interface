// @vitest-environment happy-dom
import type { ProjectFile, ProjectSummary, ThreadSummary } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from '../../src/routes/projects/project';
import { alerts, button, cleanup, click, dialog, renderAdmin, settle } from './admin-test-utils';

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
  fileCount: 1,
  threadCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const FILE: ProjectFile = {
  id: 'file-1',
  filename: 'outline.md',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  url: '/api/attachments/file-1/content',
  thumbnailUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  index: { status: 'indexed', passages: 3 },
};
const THREAD: ThreadSummary = {
  id: 'thread-1',
  title: 'Chapter one draft',
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

let features: Record<string, boolean>;
let projectResponse: () => Promise<unknown>;
let files: ProjectFile[];
let root: Root | undefined;

beforeEach(() => {
  features = { projects: true, attachments: true };
  projectResponse = async () => ({ project: PROJECT });
  files = [FILE];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features };
    if (path === '/projects/project-1') return projectResponse();
    if (path === '/projects/project-1/files') return { files };
    if (path === '/threads?projectId=project-1') return { threads: [THREAD] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ project: PROJECT });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.unstubAllGlobals();
});

async function render(tab?: string) {
  ({ root } = await renderAdmin(<ProjectPage projectId="project-1" />, {
    path: tab ? `/projects/project-1?tab=${tab}` : '/projects/project-1',
  }));
}

function tab(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No tab named ${name}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const control = target && document.getElementById(target.htmlFor);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
    throw new Error(`No field labelled ${label}`);
  }
  return control;
}

async function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('project page', () => {
  it('opens on its conversations, with pill tabs for the rest, and starts a chat inside it', async () => {
    await render();

    expect(document.querySelector('h1')?.textContent).toBe('Thesis');
    expect(
      [...document.querySelectorAll('[role="tab"]')].map((element) => [
        element.textContent,
        element.getAttribute('aria-selected'),
      ]),
    ).toEqual([
      ['Conversations', 'true'],
      ['Instructions', 'false'],
      ['Files', 'false'],
      ['Settings', 'false'],
    ]);
    const conversations = document.querySelector('[aria-label="Project conversations"]');
    expect(conversations?.querySelector('a')?.getAttribute('href')).toBe('/chat/thread-1');
    expect(conversations?.textContent).toContain('Chapter one draft');
    // Only the open tab is shown.
    expect(document.querySelector('[aria-label="Project files"]')).toBeNull();

    await click(tab('Instructions'));
    expect(field('Instructions').value).toBe('Cite sources.');
    expect(document.body.textContent).toContain('13 / 8000 characters');

    await click(tab('Files'));
    const files = document.querySelector('[aria-label="Project files"]');
    expect(files?.textContent).toContain('outline.md');
    expect(files?.querySelector('a')?.getAttribute('href')).toBe('/api/attachments/file-1/content');
    expect(document.body.textContent).toContain('1 of 20 files');

    await click(tab('Settings'));
    expect((field('Project name') as HTMLInputElement).value).toBe('Thesis');

    const newChat = [...document.querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === 'New chat in project',
    );
    expect(newChat?.getAttribute('href')).toBe('/?project=project-1');
  });

  it('shows whether each file is indexed for search and explains large projects', async () => {
    files = [
      FILE,
      {
        ...FILE,
        id: 'file-2',
        filename: 'one.txt',
        index: { status: 'indexed', passages: 1 },
      },
      { ...FILE, id: 'file-3', filename: 'photo.png', index: { status: 'no-text', passages: 0 } },
      { ...FILE, id: 'file-4', filename: 'old.pdf', index: { status: 'pending', passages: 0 } },
      {
        ...FILE,
        id: 'file-5',
        filename: 'handbook.md',
        index: { status: 'indexed', passages: 2000, truncated: true },
      },
    ];
    await render('files');

    const rows = [...document.querySelectorAll('[aria-label="Project files"] li')];
    const status = (name: string) =>
      rows.find((row) => row.textContent?.includes(name))?.querySelector('[data-index-status]')
        ?.textContent;
    expect(status('outline.md')).toBe('Searchable · 3 passages');
    expect(status('handbook.md')).toBe(
      'Partly searchable · first 2,000 passages; the rest of the file is too long to search',
    );
    expect(status('one.txt')).toBe('Searchable · 1 passage');
    expect(status('photo.png')).toBe('No text to search');
    expect(status('old.pdf')).toBe('Waiting to be indexed');
    expect(document.body.textContent).toContain(
      'When the files are too large to give in full, they are searched with each message',
    );
  });

  it('saves only the changed fields', async () => {
    api.patch.mockImplementation(async (_path: string, patch: Partial<ProjectSummary>) => {
      const project = { ...PROJECT, ...patch, updatedAt: '2026-01-04T00:00:00.000Z' };
      projectResponse = async () => ({ project });
      return { project };
    });
    await render('instructions');
    expect(button('Save changes').disabled).toBe(true);

    await typeInto(field('Instructions'), 'Cite sources in APA style.');
    await click(button('Save changes'));

    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/projects/project-1', {
      instructions: 'Cite sources in APA style.',
    });
    // Saved once the stored project matches the draft again.
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Saved');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('reports a rejected save', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.patch.mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Too long.'));
    await render('settings');
    await typeInto(field('Project name'), 'Renamed');
    await click(button('Save changes'));
    expect(alerts()).toContain('Too long.');
  });

  it('removes a file', async () => {
    await render('files');
    await click(button('Remove outline.md'));
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/projects/project-1/files/file-1');
  });

  it('uploads chosen files to the project', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await render('files');

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/files');
    expect(init.method).toBe('POST');
    expect((init.body as FormData).get('files')).toBeInstanceOf(File);
  });

  it('hides uploads when attachments are not available', async () => {
    features = { projects: true, attachments: false };
    await render('files');
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).toContain('project files are not used in conversations');
  });

  it('deletes the project after confirming what happens to its contents', async () => {
    await render('settings');
    await click(button('Delete project'));

    const confirm = dialog()!;
    expect(confirm.textContent).toContain('Delete “Thesis”?');
    expect(confirm.textContent).toContain('Its conversation is kept and leaves the project.');
    expect(confirm.textContent).toContain('Its file is deleted permanently.');
    expect(api.delete).not.toHaveBeenCalled();

    const confirmButton = [...confirm.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Delete project',
    )!;
    await click(confirmButton);
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/projects/project-1');
  });

  it('explains when the role cannot use projects, without requesting the project', async () => {
    features = { projects: false, attachments: true };
    await render();
    expect(document.body.textContent).toContain('Projects are not available for your role.');
    expect(api.get).not.toHaveBeenCalledWith('/projects/project-1');
  });

  it('reports a missing project', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    projectResponse = async () => {
      throw new ApiError(404, 'NOT_FOUND', 'Project not found');
    };
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Project not found');
  });
});
