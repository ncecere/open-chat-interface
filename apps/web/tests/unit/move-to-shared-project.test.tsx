// @vitest-environment happy-dom
import type { ProjectSummary } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoveToProjectDialog } from '../../src/components/projects/project-dialogs';
import { button, cleanup, click, dialog, dismissToasts, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function project(id: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    name,
    instructions: '',
    fileCount: 0,
    threadCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

let root: Root | undefined;

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/projects')
      return {
        projects: [project('p1', 'Thesis')],
        shared: [project('s1', 'Lab handbook', { access: 'viewer', ownerName: 'Olive Owner' })],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ thread: { id: 'thread-1' } });
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
});

describe('moving a conversation into a project shared with the person', () => {
  it('offers the shared project, named with its owner, after their own', async () => {
    ({ root } = await renderAdmin(
      <>
        <MoveToProjectDialog
          threadId="thread-1"
          currentProjectId={null}
          open
          onOpenChange={() => undefined}
        />
        <Toaster />
      </>,
    ));
    const labels = [...dialog()!.querySelectorAll('label')].map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toEqual(['No project', 'Thesis', 'Lab handbook (shared by Olive Owner)']);

    const option = [...dialog()!.querySelectorAll<HTMLLabelElement>('label')][2]!.querySelector(
      'input',
    )!;
    await click(option);
    await click(button('Move'));
    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/threads/thread-1', { projectId: 's1' });
    // The notice names the project, not the explanation added for choosing it.
    expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain(
      'Conversation moved to “Lab handbook”.',
    );
  });
});
