// @vitest-environment happy-dom
import type { ProjectFile } from '@oci/shared';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectFilesControl } from '../../src/components/chat/project-files-control';
import { cleanup, click, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function file(id: string, filename: string, status: ProjectFile['index']['status']): ProjectFile {
  return {
    id,
    filename,
    mimeType: 'text/plain',
    sizeBytes: 100,
    url: `/api/attachments/${id}/content`,
    thumbnailUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    index: { status, passages: status === 'indexed' ? 3 : 0 },
  };
}

let files: ProjectFile[];
let features: Record<string, boolean>;
let root: Root | undefined;
let changes: string[][];

beforeEach(() => {
  files = [file('f1', 'handbook.pdf', 'indexed'), file('f2', 'trip-plan.md', 'pending')];
  features = { projects: true, attachments: true };
  changes = [];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features };
    if (path === '/projects/project-1/files') return { files };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** Holds the excluded ids like the chat session does. */
function Harness({ initial = [] as string[] }) {
  const [excluded, setExcluded] = useState(initial);
  return (
    <ProjectFilesControl
      projectId="project-1"
      excluded={excluded}
      onExcludedChange={(ids) => {
        changes.push(ids);
        setExcluded(ids);
      }}
    />
  );
}

async function render(initial: string[] = []) {
  ({ root } = await renderAdmin(<Harness initial={initial} />));
}

const trigger = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="project-files-control"]');
const checkbox = (name: string) => {
  const label = [...document.querySelectorAll('label')].find((node) => node.textContent === name);
  return document.getElementById(label!.htmlFor) as HTMLInputElement;
};

describe('project files control', () => {
  it('lists every project file, all ticked, and leaves an unticked one out', async () => {
    await render();
    expect(trigger()?.getAttribute('aria-label')).toBe('Project files');
    await click(trigger()!);
    expect(document.body.textContent).toContain('Project files for the next message');
    expect(checkbox('handbook.pdf').checked).toBe(true);
    expect(checkbox('trip-plan.md').checked).toBe(true);

    await click(checkbox('trip-plan.md'));
    expect(changes.at(-1)).toEqual(['f2']);
    expect(checkbox('trip-plan.md').checked).toBe(false);
    expect(trigger()?.getAttribute('aria-label')).toBe('Project files: 1 of 2');

    const useAll = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use all files',
    );
    await click(useAll!);
    expect(changes.at(-1)).toEqual([]);
    expect(checkbox('trip-plan.md').checked).toBe(true);
  });

  it('ticks a file back in', async () => {
    await render(['f1']);
    await click(trigger()!);
    expect(checkbox('handbook.pdf').checked).toBe(false);
    await click(checkbox('handbook.pdf'));
    expect(changes.at(-1)).toEqual([]);
  });

  it('ignores ids of files the project no longer has', async () => {
    await render(['gone']);
    expect(trigger()?.getAttribute('aria-label')).toBe('Project files');
  });

  it('is not shown when no file is indexed for search', async () => {
    files = [file('f2', 'trip-plan.md', 'pending'), file('f3', 'photo.png', 'no-text')];
    await render();
    expect(trigger()).toBeNull();
  });

  it('is not shown, and does not ask for files, without the projects feature', async () => {
    features = { projects: false, attachments: true };
    await render();
    expect(trigger()).toBeNull();
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalledWith('/projects/project-1/files');
  });
});
