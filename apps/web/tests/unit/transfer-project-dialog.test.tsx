// @vitest-environment happy-dom
import type { ProjectShare } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferProjectSection } from '../../src/components/projects/transfer-dialog';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  dismissToasts,
  expectLocked,
  renderAdmin,
} from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const at = '2026-10-01T00:00:00.000Z';
const person = (id: string, name: string, permission: 'viewer' | 'editor'): ProjectShare => ({
  id: `share-${id}`,
  permission,
  subject: { type: 'person', userId: id, name, email: `${id}@example.test` },
  createdAt: at,
  updatedAt: at,
});

let shares: ProjectShare[];
let root: Root | undefined;

beforeEach(() => {
  shares = [
    person('v1', 'Vera Viewer', 'viewer'),
    person('e1', 'Edgar Editor', 'editor'),
    {
      id: 'share-g',
      permission: 'editor',
      subject: { type: 'group', groupId: 'g1', name: 'Biology', memberCount: 4 },
      createdAt: at,
      updatedAt: at,
    },
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/projects/p1/shares') return { shares };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ project: { id: 'p1', access: 'editor' } });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function render() {
  ({ root } = await renderAdmin(
    <>
      <TransferProjectSection project={{ id: 'p1', name: 'Thesis' }} />
      <Toaster />
    </>,
  ));
}

function inDialog(name: string): HTMLButtonElement {
  const found = [...dialog()!.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named "${name}" in the dialog`);
  return found;
}

describe('Transfer ownership', () => {
  it('explains the transfer in the section before opening anything', async () => {
    await render();
    expect(document.body.textContent).toContain('Transfer ownership');
    expect(document.body.textContent).toContain('someone who already has editor access');
  });

  it('offers only people with a direct editor share, not viewers or groups', async () => {
    await render();
    await click(button('Transfer project…'));
    const choices = [...dialog()!.querySelectorAll('input[type="radio"]')].map(
      (input) => (input as HTMLInputElement).labels?.[0]?.textContent,
    );
    expect(choices).toEqual(['Edgar Editor (e1@example.test)']);
  });

  it('says what changes, and transfers to the person chosen', async () => {
    await render();
    await click(button('Transfer project…'));
    expect(inDialog('Transfer project').disabled).toBe(true);

    await click(dialog()!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('Transfer “Thesis” to Edgar Editor?');
    expect(text).toContain('Edgar Editor becomes the owner');
    expect(text).toContain('rename, delete, share and transfer');
    expect(text).toContain('You stay on the project as an editor');
    expect(text).toContain('Files and conversations stay where they are');
    expect(api.post).not.toHaveBeenCalled();

    await click(inDialog('Transfer project'));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/projects/p1/transfer', {
      email: 'e1@example.test',
    });
    await dismissToasts();
  });

  it('explains how to become eligible when nobody is', async () => {
    shares = [person('v1', 'Vera Viewer', 'viewer')];
    await render();
    await click(button('Transfer project…'));
    expect(dialog()!.textContent).toContain(
      'Only a person you have shared the project with directly as an editor can become its owner.',
    );
    expect(dialog()!.querySelector('input[type="radio"]')).toBeNull();
    expect(inDialog('Transfer project').disabled).toBe(true);
  });

  it('shows why the server refused', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'They already have 100 projects.', {
        reason: 'transfer_target_project_limit',
      }),
    );
    await render();
    await click(button('Transfer project…'));
    await click(dialog()!.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await click(inDialog('Transfer project'));
    expect(alerts(dialog()!).join(' ')).toContain('They already have 100 projects.');
  });

  it('is off while read-only', async () => {
    const { setReadOnlyStatus } = await import('../../src/lib/read-only');
    const { INACTIVE_READ_ONLY_STATUS } = await import('@oci/shared');
    setReadOnlyStatus({ ...INACTIVE_READ_ONLY_STATUS, active: true, source: 'administrator' });
    try {
      await render();
      expectLocked(button('Transfer project…'), 'Read-only for maintenance');
    } finally {
      setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS);
    }
  });
});
