// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminGroupDetailPage } from '../../src/routes/admin/group-detail';
import {
  alerts,
  button,
  buttonNames,
  cleanup,
  click,
  dialog,
  dismissToasts,
  findButton,
  renderAdmin,
  settle,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';
import { group, groupDetail, member, membersPage } from './groups-fixtures';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
// The shared test router only has a catch-all route, so supply the parameter.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => ({ groupId: 'group-1' }),
}));

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/groups/group-1') return groupDetail();
    if (path.startsWith('/admin/groups/group-1/members')) return membersPage();
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
});

const gets = () => api.get.mock.calls.map(([path]) => path as string);
const memberGets = () => gets().filter((path) => path.includes('/members'));

async function render(options: { path?: string; role?: 'admin' | 'auditor' } = {}) {
  const rendered = await renderAdmin(<AdminGroupDetailPage />, {
    path: options.path ?? '/admin/groups/group-1',
    role: options.role,
  });
  root = rendered.root;
  return rendered;
}

function row(email: string): HTMLElement {
  const cell = [...document.querySelectorAll('td')].find((td) => td.textContent === email);
  if (!cell?.parentElement) throw new Error(`No row for ${email}`);
  return cell.parentElement;
}

function inDialog(name: string): HTMLButtonElement {
  const match = [...dialog()!.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named "${name}" in the dialog`);
  return match;
}

async function chooseRole(label: string, name: string) {
  await click(button(name));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`No option named "${label}"`);
  await click(option);
}

describe('the group page', () => {
  it('names the group, says what it holds and offers its four sections', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Biology');
    const text = document.body.textContent ?? '';
    expect(text).toContain('The biology department');
    expect(text).toContain('3 members');
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Members',
      'Budgets and models',
      'Usage',
      'Settings',
    ]);
    expect(document.querySelector('a[href="/admin/groups"]')?.textContent).toContain('All groups');
  });

  it('opens on the section named in the address', async () => {
    await render({ path: '/admin/groups/group-1?tab=settings' });
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Settings',
    );
    expect(document.querySelector('#group-settings-name')).not.toBeNull();
  });

  it('opens on Members when the address names a section there is not', async () => {
    await render({ path: '/admin/groups/group-1?tab=nonsense' });
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Members',
    );
  });

  it('says so, with a way back, when the group is gone', async () => {
    api.get.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Group not found'));
    await render();
    expect(alerts()).toContain('This group could not be loaded.');
    expect(document.querySelector('a[href="/admin/groups"]')).not.toBeNull();
  });
});

describe('Members', () => {
  it('lists the people with their role and a labelled control for each change', async () => {
    await render();
    expect(row('ada@example.test').textContent).toContain('Ada Lovelace');
    expect(buttonNames()).toEqual(
      expect.arrayContaining([
        'Role of Ada Lovelace',
        'Remove Ada Lovelace',
        'Role of Grace Hopper',
        'Remove Grace Hopper',
      ]),
    );
    expect(document.body.textContent).toContain('Showing 1–2 of 2');
  });

  it('searches by name or email from the first page', async () => {
    await render();
    await typeInto(document.querySelector('input[aria-label="Search members"]')!, 'ada');
    expect(memberGets().at(-1)).toBe('/admin/groups/group-1/members?search=ada&page=1');
  });

  it('pages through a large group', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/groups/group-1'
        ? groupDetail({ memberCount: 120 })
        : membersPage([member()], { total: 120, page: path.includes('page=2') ? 2 : 1 }),
    );
    await render();
    expect(document.body.textContent).toContain('Showing 1–50 of 120');
    await click(button('Next'));
    expect(memberGets().at(-1)).toBe('/admin/groups/group-1/members?page=2');
    expect(document.body.textContent).toContain('Showing 51–100 of 120');
  });

  it('adds people by email with the role chosen, and says who it could not add', async () => {
    api.post.mockResolvedValue({
      added: [{ userId: 'user-9', email: 'new@example.test', role: 'manager' }],
      alreadyMembers: ['ada@example.test'],
      unknown: ['typo@example.test'],
      memberCount: 4,
    });
    await render();
    await typeIntoTextarea(
      document.querySelector('#member-emails')!,
      'New@Example.test, ada@example.test\ntypo@example.test',
    );
    await chooseRole('Manager', 'Role for the new people');
    await click(button('Add people'));

    expect(api.post).toHaveBeenCalledWith('/admin/groups/group-1/members', {
      emails: ['new@example.test', 'ada@example.test', 'typo@example.test'],
      role: 'manager',
    });
    const status = document.querySelector('[data-testid="add-outcome"]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('Added 1 person. The group now has 4 members.');
    expect(status.textContent).toContain('Already in the group');
    expect(status.textContent).toContain('ada@example.test');
    expect(status.textContent).toContain('No account with this address');
    expect(status.textContent).toContain('typo@example.test');
    // What had no account stays in the box to be corrected; the rest is done.
    expect((document.querySelector('#member-emails') as HTMLTextAreaElement).value).toBe(
      'typo@example.test',
    );
  });

  it('names the entries that are not email addresses and sends nothing', async () => {
    await render();
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'ok@example.test, nobody');
    await click(button('Add people'));
    expect(api.post).not.toHaveBeenCalled();
    const field = document.querySelector('#member-emails')!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('member-emails-error')?.textContent).toContain('nobody');
  });

  it('asks for at least one address', async () => {
    await render();
    await click(button('Add people'));
    expect(api.post).not.toHaveBeenCalled();
    expect(document.getElementById('member-emails-error')?.textContent).toContain(
      'Enter at least one email address.',
    );
  });

  it('says who is in too many groups, with the limit the server named', async () => {
    api.post.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'A person can be in at most 50 groups.', {
        reason: 'person_group_limit',
        limit: 50,
        emails: ['busy@example.test'],
      }),
    );
    await render();
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'busy@example.test');
    await click(button('Add people'));
    expect(alerts()).toContain(
      'A person can be in at most 50 groups. Not added: busy@example.test.',
    );
  });

  it('changes a role, and shows the manager limit when it is refused', async () => {
    api.patch.mockResolvedValueOnce(member({ role: 'manager' }));
    await render();
    await chooseRole('Manager', 'Role of Ada Lovelace');
    expect(api.patch).toHaveBeenCalledWith('/admin/groups/group-1/members/user-1', {
      role: 'manager',
    });

    api.patch.mockRejectedValueOnce(
      new ApiError(409, 'CONFLICT', 'A group can have at most 20 managers.', {
        reason: 'manager_limit',
        limit: 20,
      }),
    );
    await chooseRole('Manager', 'Role of Ada Lovelace');
    expect(alerts()).toContain('A group can have at most 20 managers.');
  });

  it('removes a member after saying what they lose', async () => {
    api.delete.mockResolvedValue({ ok: true });
    await render();
    await click(button('Remove Ada Lovelace'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Remove Ada Lovelace?');
    expect(dialog()?.textContent).toContain('the budgets and models');
    expect(api.delete).not.toHaveBeenCalled();

    await click(button('Remove from group'));
    expect(api.delete).toHaveBeenCalledWith('/admin/groups/group-1/members/user-1');
    expect(dialog()).toBeNull();
  });

  it('is read-only for an auditor: the list and nothing that changes it', async () => {
    await render({ role: 'auditor' });
    expect(row('ada@example.test').textContent).toContain('Member');
    expect(document.querySelector('#member-emails')).toBeNull();
    expect(findButton('Add people')).toBeUndefined();
    expect(findButton('Remove Ada Lovelace')).toBeUndefined();
    expect(findButton('Role of Ada Lovelace')).toBeUndefined();
    // Reading still works: search and the other sections.
    expect(document.querySelector('input[aria-label="Search members"]')).not.toBeNull();
  });
});

describe('Settings', () => {
  const open = () => render({ path: '/admin/groups/group-1?tab=settings' });

  it('renames and describes the group, sending only what changed', async () => {
    api.patch.mockResolvedValue(group({ name: 'Life sciences' }));
    await open();
    expect((button('Save changes') as HTMLButtonElement).disabled).toBe(true);

    await typeInto(document.querySelector('#group-settings-name')!, 'Life sciences');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/groups/group-1', { name: 'Life sciences' });
    expect(document.body.textContent).toContain('Saved.');
  });

  it('clears the description when it is emptied', async () => {
    api.patch.mockResolvedValue(group({ description: null }));
    await open();
    await typeIntoTextarea(document.querySelector('#group-settings-description')!, '  ');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/groups/group-1', { description: null });
  });

  it('puts a name already in use at the Name field', async () => {
    api.patch.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'A group named “Chemistry” already exists.', {
        reason: 'name_taken',
      }),
    );
    await open();
    await typeInto(document.querySelector('#group-settings-name')!, 'chemistry');
    await click(button('Save changes'));
    expect(document.getElementById('group-settings-name-error')?.textContent).toBe(
      'A group named “Chemistry” already exists.',
    );
    expect(document.querySelector('#group-settings-name')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('shows what deleting removes, with the counts the server holds, before deleting', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/groups/group-1'
        ? groupDetail({ memberCount: 12, policyCount: 2, modelCount: 3, sharedProjectCount: 4 })
        : membersPage(),
    );
    api.delete.mockResolvedValue({
      ok: true,
      removed: { members: 12, policies: 2, models: 3, sharedProjects: 4 },
    });
    const rendered = await open();
    await click(button('Delete group'));

    const text = dialog()?.textContent ?? '';
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete Biology?');
    expect(text).toContain('12 members');
    expect(text).toContain('2 budgets');
    expect(text).toContain('3 models');
    expect(text).toContain('4 shared projects');
    expect(api.delete).not.toHaveBeenCalled();

    await click(inDialog('Delete group'));
    expect(api.delete).toHaveBeenCalledWith('/admin/groups/group-1');
    await settle();
    expect(rendered.router.state.location.pathname).toBe('/admin/groups');
  });

  it('shows a group with nothing attached without the empty counts', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/groups/group-1'
        ? groupDetail({ memberCount: 0, managerCount: 0, policyCount: 0, modelCount: 0 })
        : membersPage([]),
    );
    await open();
    await click(button('Delete group'));
    const text = dialog()?.textContent ?? '';
    expect(text).not.toContain('0 members');
    expect(text).toContain('It has no members');
  });

  it('is read-only for an auditor: the values, no Save and no Delete', async () => {
    await render({ path: '/admin/groups/group-1?tab=settings', role: 'auditor' });
    const name = document.querySelector('#group-settings-name') as HTMLInputElement;
    expect(name.value).toBe('Biology');
    expect(name.closest('fieldset')?.disabled).toBe(true);
    expect(findButton('Save changes')).toBeUndefined();
    expect(findButton('Delete group')).toBeUndefined();
  });
});
