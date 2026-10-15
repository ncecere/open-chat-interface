// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminGroupsPage } from '../../src/routes/admin/groups';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';
import { group, groupsPage } from './groups-fixtures';

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

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockResolvedValue(groupsPage());
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const gets = () => api.get.mock.calls.map(([path]) => path as string);

it('lists each group with what it holds, as a link to its page', async () => {
  api.get.mockResolvedValue(
    groupsPage([
      group(),
      group({ id: 'group-2', name: 'Chemistry', description: null, memberCount: 1 }),
    ]),
  );
  ({ root } = await renderAdmin(<AdminGroupsPage />));

  expect(document.querySelector('h1')?.textContent).toBe('Groups');
  const links = [...document.querySelectorAll('a')].filter((link) =>
    link.getAttribute('href')?.startsWith('/admin/groups/'),
  );
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Biology', '/admin/groups/group-1'],
    ['Chemistry', '/admin/groups/group-2'],
  ]);
  const text = document.body.textContent ?? '';
  expect(text).toContain('3 members');
  expect(text).toContain('1 manager');
  expect(text).toContain('1 budget');
  expect(text).toContain('2 models');
  expect(text).toContain('The biology department');
  // The cap, so an administrator sees how many may still be made.
  expect(text).toContain('2 of 500 groups');
});

it('says a group only adds, so nobody reads it as a way to take access away', async () => {
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  expect(document.body.textContent).toMatch(/only add|never take away/i);
});

it('searches by name, from the first page', async () => {
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  expect(gets()).toEqual(['/admin/groups?page=1']);

  await typeInto(document.querySelector('input[aria-label="Search groups"]')!, 'bio');
  expect(gets().at(-1)).toBe('/admin/groups?search=bio&page=1');
});

it('pages through the groups and says where it is, politely', async () => {
  api.get.mockImplementation(async (path: string) =>
    groupsPage([group({ id: path.includes('page=2') ? 'g-b' : 'g-a' })], {
      total: 120,
      page: path.includes('page=2') ? 2 : 1,
    }),
  );
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  const nav = document.querySelector('nav[aria-label="Group list pages"]')!;
  expect(nav.textContent).toContain('Showing 1–50 of 120');
  expect((button('Previous') as HTMLButtonElement).disabled).toBe(true);

  await click(button('Next'));
  expect(gets().at(-1)).toBe('/admin/groups?page=2');
  expect(nav.querySelector('[aria-live="polite"]')?.textContent).toContain('Showing 51–100 of 120');
});

it('shows an empty list as guidance, and an empty search as no match', async () => {
  api.get.mockResolvedValue(groupsPage([]));
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  expect(document.body.textContent).toContain('No groups yet.');

  await typeInto(document.querySelector('input[aria-label="Search groups"]')!, 'zzz');
  expect(document.body.textContent).toContain('No groups match');
});

it('offers a retry when the list cannot be loaded', async () => {
  api.get.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Database is away'));
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  expect(alerts()).toContain('Groups could not be loaded.');
  await click(button('Try again'));
  expect(document.body.textContent).toContain('Biology');
});

it('creates a group and goes to its page', async () => {
  api.post.mockResolvedValue(group({ id: 'group-9', name: 'Physics' }));
  const rendered = await renderAdmin(<AdminGroupsPage />);
  root = rendered.root;
  await click(button('New group'));

  expect(dialog()?.querySelector('h2')?.textContent).toBe('New group');
  await typeInto(dialog()!.querySelector('#group-name')!, '  Physics ');
  await typeIntoTextarea(dialog()!.querySelector('#group-description')!, 'The physics department');
  await click(button('Create group'));

  expect(api.post).toHaveBeenCalledWith('/admin/groups', {
    name: 'Physics',
    description: 'The physics department',
  });
  expect(dialog()).toBeNull();
  expect(rendered.router.state.location.pathname).toBe('/admin/groups/group-9');
});

it('asks for a name at the field before sending anything', async () => {
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  await click(button('New group'));
  await click(button('Create group'));

  expect(api.post).not.toHaveBeenCalled();
  const name = dialog()!.querySelector('#group-name')!;
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById('group-name-error')?.textContent).toBe(
    'Name: Give the group a name.',
  );
});

it('puts a taken name at the Name field', async () => {
  api.post.mockRejectedValue(
    new ApiError(409, 'CONFLICT', 'A group named “Biology” already exists.', {
      reason: 'name_taken',
    }),
  );
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  await click(button('New group'));
  await typeInto(dialog()!.querySelector('#group-name')!, 'biology');
  await click(button('Create group'));

  const name = dialog()!.querySelector('#group-name')!;
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById('group-name-error')?.textContent).toBe(
    'A group named “Biology” already exists.',
  );

  // Editing the name clears it: it may no longer hold.
  await typeInto(name as HTMLInputElement, 'biology 2');
  expect(document.getElementById('group-name-error')).toBeNull();
});

it('states the limit when the instance has all the groups it may have', async () => {
  api.post.mockRejectedValue(
    new ApiError(409, 'CONFLICT', 'An instance can have at most 500 groups.', {
      reason: 'group_limit',
      limit: 500,
    }),
  );
  ({ root } = await renderAdmin(<AdminGroupsPage />));
  await click(button('New group'));
  await typeInto(dialog()!.querySelector('#group-name')!, 'One too many');
  await click(button('Create group'));
  expect(alerts(dialog()!)).toEqual(['An instance can have at most 500 groups.']);
});

it('is read-only for an auditor: they read the list and cannot create', async () => {
  ({ root } = await renderAdmin(<AdminGroupsPage />, { role: 'auditor' }));
  expect(document.body.textContent).toContain('Biology');
  expect(findButton('New group')).toBeUndefined();
});
