// @vitest-environment happy-dom
import type { ProjectSummary } from '@oci/shared';
import { useState } from 'react';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoveToProjectDialog } from '../../src/components/projects/project-dialogs';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  dismissToasts,
  renderAdmin,
} from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function project(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    instructions: '',
    fileCount: 0,
    threadCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const closed = vi.fn();
let root: Root | undefined;

function Harness({ current }: { current: string | null }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <MoveToProjectDialog
        threadId="thread-1"
        currentProjectId={current}
        open={open}
        onOpenChange={(next) => {
          if (!next) closed();
          setOpen(next);
        }}
      />
      <Toaster />
    </>
  );
}

/** The notice's text, from Sonner's own polite live region; null when there is none. */
function announced(): string | null {
  const region = document.querySelector('[aria-live="polite"]');
  const notice = region?.querySelector('[data-sonner-toast]');
  return notice?.textContent ?? null;
}

beforeEach(() => {
  closed.mockReset();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/projects')
      return { projects: [project('p1', 'Thesis'), project('p2', 'Grants')] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ thread: { id: 'thread-1' } });
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
});

function radio(label: string): HTMLInputElement {
  const match = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = match?.querySelector('input[type="radio"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`No option ${label}`);
  return input;
}

describe('move to project dialog', () => {
  it('offers every project and no project as one labelled radio group', async () => {
    ({ root } = await renderAdmin(<Harness current="p1" />));

    expect(dialog()?.querySelector('h2')?.textContent).toBe('Move to project');
    const radios = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
    expect(radios.map((input) => input.type)).toEqual(['radio', 'radio', 'radio']);
    expect(new Set(radios.map((input) => input.name)).size).toBe(1);
    expect(dialog()?.querySelector('legend')?.textContent).toBe('Project');
    expect(radio('Thesis').checked).toBe(true);
    // Nothing to save until the choice changes.
    expect(button('Move').disabled).toBe(true);
  });

  it('moves the conversation into the chosen project and closes', async () => {
    ({ root } = await renderAdmin(<Harness current="p1" />));
    await click(radio('Grants'));
    await click(button('Move'));

    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/threads/thread-1', { projectId: 'p2' });
    expect(closed).toHaveBeenCalled();
    expect(dialog()).toBeNull();
    // Said, and announced: the conversation on screen does not change (#294).
    await vi.waitFor(() => expect(announced()).toContain('Conversation moved to “Grants”.'));
  });

  it('takes the conversation out of its project with No project', async () => {
    ({ root } = await renderAdmin(<Harness current="p1" />));
    await click(radio('No project'));
    await click(button('Move'));
    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/threads/thread-1', { projectId: null });
    await vi.waitFor(() => expect(announced()).toContain('Conversation moved out of “Thesis”.'));
  });

  it('keeps the dialog open and explains a refused move', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.patch.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project not found'));
    ({ root } = await renderAdmin(<Harness current={null} />));
    expect(radio('No project').checked).toBe(true);

    await click(radio('Thesis'));
    await click(button('Move'));
    expect(alerts()).toContain('Project not found');
    expect(dialog()).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(announced()).toBeNull();
  });
});
