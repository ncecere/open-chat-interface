// @vitest-environment happy-dom
import type { AccountSharingImpact } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteUserSection } from '../../src/components/admin/delete-user';
import { DeleteAccountSection } from '../../src/routes/settings/account/delete-account-section';
import { button, cleanup, click, dialog, renderAdmin, settle, typeInto } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const IMPACT: AccountSharingImpact = {
  sharedProjects: 2,
  otherConversations: 3,
  othersFiles: 4,
  filesHandedToOwners: 5,
};
const NONE: AccountSharingImpact = {
  sharedProjects: 0,
  otherConversations: 0,
  othersFiles: 0,
  filesHandedToOwners: 0,
};

let impact: () => Promise<AccountSharingImpact>;
let root: Root | undefined;

beforeEach(() => {
  impact = async () => IMPACT;
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'me', name: 'Ada', email: 'ada@example.test' },
        features: { accountDeletion: true },
        signIn: { password: true, credential: false, sso: [] },
      };
    if (path === '/admin/users/user-1/sharing-impact' || path === '/me/sharing-impact')
      return impact();
    throw new Error(`Unexpected GET ${path}`);
  });
  api.delete.mockReset().mockResolvedValue({ ok: true });
  api.post.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const target = { id: 'user-1', name: 'Dana Admin', email: 'dana@example.test' };

function confirmButton(label: string): HTMLButtonElement {
  const found = [...dialog()!.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No ${label}`);
  return found;
}

describe('an administrator deleting a person', () => {
  it('reads the impact when the dialog opens and shows each count in plain words', async () => {
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    // Not read until the dialog is wanted.
    expect(api.get).not.toHaveBeenCalledWith('/admin/users/user-1/sharing-impact');
    await click(button('Delete user'));
    expect(api.get).toHaveBeenCalledWith('/admin/users/user-1/sharing-impact');

    const text = dialog()!.textContent ?? '';
    expect(text).toContain('This also affects other people');
    expect(text).toContain('2 shared projects it owns are deleted.');
    expect(text).toContain(
      '3 conversations other people have in those projects are kept, but leave the project.',
    );
    expect(text).toContain('4 files other people added to those projects are deleted with them.');
    expect(text).toContain(
      "5 files it added to other people's projects stay, and go to the projects' owners.",
    );
  });

  it('uses the singular for one', async () => {
    impact = async () => ({
      sharedProjects: 1,
      otherConversations: 1,
      othersFiles: 1,
      filesHandedToOwners: 1,
    });
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    await click(button('Delete user'));
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('1 shared project it owns is deleted.');
    expect(text).toContain(
      '1 conversation other people have in those projects is kept, but leaves the project.',
    );
    expect(text).toContain('1 file other people added to those projects is deleted with them.');
    expect(text).toContain(
      "1 file it added to other people's projects stays, and goes to the projects' owners.",
    );
  });

  it('leaves out what is zero, and says nobody else is affected when all of it is', async () => {
    impact = async () => ({ ...NONE, filesHandedToOwners: 5 });
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    await click(button('Delete user'));
    expect(dialog()!.textContent).not.toContain('shared project');
    expect(dialog()!.textContent).toContain("5 files it added to other people's projects stay");

    await cleanup(root);
    impact = async () => NONE;
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    await click(button('Delete user'));
    expect(dialog()!.textContent).toContain(
      'Deleting this account does not affect other people’s projects or conversations.',
    );
  });

  it('holds the confirmation back until the impact is known, then lets the typed email confirm', async () => {
    let release: (value: AccountSharingImpact) => void = () => undefined;
    impact = () => new Promise((resolve) => (release = resolve));
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    await click(button('Delete user'));
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toContain(
      'Checking what this affects',
    );
    await typeInto(
      document.getElementById('delete-user-confirm') as HTMLInputElement,
      'dana@example.test',
    );
    expect(confirmButton('Delete user').disabled).toBe(true);

    release(IMPACT);
    await settle();
    await vi.waitFor(() => expect(confirmButton('Delete user').disabled).toBe(false));
  });

  it('still lets the deletion go ahead when the impact could not be read, and says so', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    impact = async () => {
      throw new ApiError(500, 'INTERNAL_ERROR', 'Boom');
    };
    ({ root } = await renderAdmin(<DeleteUserSection user={target} />));
    await click(button('Delete user'));
    expect(dialog()!.textContent).toContain('Could not check how this affects other people');
    await typeInto(
      document.getElementById('delete-user-confirm') as HTMLInputElement,
      'dana@example.test',
    );
    expect(confirmButton('Delete user').disabled).toBe(false);
  });
});

describe('a person deleting their own account', () => {
  it('says what it does to the projects they share and the files they added to others', async () => {
    ({ root } = await renderAdmin(<DeleteAccountSection />));
    await click(button('Delete account'));
    expect(api.get).toHaveBeenCalledWith('/me/sharing-impact');
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('This also affects other people');
    expect(text).toContain('2 shared projects you own are deleted.');
    expect(text).toContain(
      '3 conversations other people have in those projects are kept, but leave the project.',
    );
    expect(text).toContain('4 files other people added to those projects are deleted with them.');
    expect(text).toContain(
      "5 files you added to other people's projects stay, and go to the projects' owners.",
    );
  });

  it('says nobody else is affected when nothing is shared', async () => {
    impact = async () => NONE;
    ({ root } = await renderAdmin(<DeleteAccountSection />));
    await click(button('Delete account'));
    expect(dialog()!.textContent).toContain(
      'Deleting your account does not affect other people’s projects or conversations.',
    );
  });
});
