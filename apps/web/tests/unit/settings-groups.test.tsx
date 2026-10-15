// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { ApiError } from '../../src/lib/api-client';
import { pageTitleFor } from '../../src/lib/document-title';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsGroupsPage } from '../../src/routes/settings/groups';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  dismissToasts,
  findButton,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';
import { managed, member, membersPage } from './groups-fixtures';

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
let managedGroups = [managed()];
let me: Record<string, unknown>;
beforeEach(() => {
  localStorage.clear();
  for (const method of Object.values(api)) method.mockReset();
  managedGroups = [managed()];
  me = {
    user: { id: 'user-2', name: 'Grace Hopper', email: 'grace@example.test', role: 'user' },
    settingsSummary: { memoryEntries: 0, connectors: 0, managedGroups: 1 },
  };
  api.get.mockImplementation(async (path: string) => {
    if (path === '/me') return me;
    if (path === '/groups/managed') return { groups: managedGroups };
    if (path.startsWith('/groups/managed/')) return membersPage();
    return { allowances: [] };
  });
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
  localStorage.clear();
});

async function renderPage() {
  const rendered = await renderAdmin(<SettingsGroupsPage />, { path: '/settings/groups' });
  root = rendered.root;
  return rendered;
}

const memberGets = () =>
  api.get.mock.calls.map(([path]) => path as string).filter((path) => path.includes('/members'));

function row(email: string): HTMLElement {
  const cell = [...document.querySelectorAll('td')].find((td) => td.textContent === email);
  if (!cell?.parentElement) throw new Error(`No row for ${email}`);
  return cell.parentElement;
}

describe('Settings → Groups tab', () => {
  const tabLabels = () =>
    [...document.querySelectorAll('nav[aria-label="Settings sections"] a')].map(
      (link) => link.textContent,
    );
  const layout = async (path = '/settings/history') => {
    const rendered = await renderAdmin(
      <ThemeProvider>
        <SettingsLayout />
      </ThemeProvider>,
      { path },
    );
    root = rendered.root;
  };

  it('is there for a manager, after Sharing', async () => {
    await layout();
    expect(tabLabels()).toContain('Groups');
    expect(tabLabels().indexOf('Groups')).toBeGreaterThan(tabLabels().indexOf('Sharing'));
  });

  it('is not there for someone who manages nothing', async () => {
    me = { ...me, settingsSummary: { memoryEntries: 0, connectors: 0, managedGroups: 0 } };
    await layout();
    expect(tabLabels()).not.toContain('Groups');
    const menu = document.querySelector('[aria-label="Settings section"]')!;
    expect(menu.textContent).not.toContain('Groups');
  });

  it('is not there from an older API that does not say, nor before the answer', async () => {
    me = { ...me, settingsSummary: { memoryEntries: 0, connectors: 0 } };
    await layout();
    expect(tabLabels()).not.toContain('Groups');
  });

  it('names its tab in the browser title', () => {
    expect(pageTitleFor('/settings/groups')).toBe('Groups · Settings');
  });
});

describe('Settings → Groups', () => {
  it('shows the group, how full it is, and its people', async () => {
    await renderPage();
    expect(document.querySelector('h1')?.textContent).toBe('Groups');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Biology');
    expect(text).toContain('The biology department');
    expect(text).toContain('3 of 5,000 members');
    expect(row('ada@example.test').textContent).toContain('Ada Lovelace');
    expect(memberGets()).toEqual(['/groups/managed/group-1/members?page=1']);
  });

  it('gives a manager no grants, usage or roles: nothing but people', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/budget|usage|grant|model/i);
    expect(document.querySelector('[role="option"], select, [role="combobox"]')).toBeNull();
    expect(api.get.mock.calls.map(([path]) => path as string)).not.toContainEqual(
      expect.stringMatching(/^\/admin/),
    );
  });

  it('chooses between groups when the person manages several', async () => {
    managedGroups = [managed(), managed({ id: 'group-2', name: 'Chemistry', memberCount: 8 })];
    await renderPage();
    expect(document.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe('Group');
    await click(document.querySelector('[role="combobox"]') as HTMLElement);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent === 'Chemistry',
    )!;
    await click(option);
    expect(memberGets().at(-1)).toBe('/groups/managed/group-2/members?page=1');
    expect(document.body.textContent).toContain('8 of 5,000 members');
  });

  it('says so, and nothing about any group, to someone who manages none', async () => {
    managedGroups = [];
    await renderPage();
    expect(document.body.textContent).toContain('You do not manage any groups.');
    expect(memberGets()).toEqual([]);
  });

  it('searches the members', async () => {
    await renderPage();
    await typeInto(document.querySelector('input[aria-label="Search members"]')!, 'ada');
    expect(memberGets().at(-1)).toBe('/groups/managed/group-1/members?search=ada&page=1');
  });

  it('adds people by email as members, with no role to choose', async () => {
    api.post.mockResolvedValue({
      added: [{ userId: 'user-9', email: 'new@example.test', role: 'member' }],
      alreadyMembers: [],
      unknown: ['typo@example.test'],
      memberCount: 4,
    });
    await renderPage();
    expect(document.querySelector('[aria-label="Role for the new people"]')).toBeNull();
    await typeIntoTextarea(
      document.querySelector('#member-emails')!,
      'New@example.test\ntypo@example.test',
    );
    await click(button('Add people'));

    expect(api.post).toHaveBeenCalledWith('/groups/managed/group-1/members', {
      emails: ['new@example.test', 'typo@example.test'],
    });
    const status = document.querySelector('[data-testid="add-outcome"]')!;
    expect(status.textContent).toContain('Added 1 person. The group now has 4 members.');
    expect(status.textContent).toContain('No account with this address');
    expect(status.textContent).toContain('typo@example.test');
  });

  it('says how long to wait after too many lookups, from Retry-After', async () => {
    api.post.mockRejectedValue(
      new ApiError(429, 'RATE_LIMITED', 'Too many lookups.', undefined, 12),
    );
    await renderPage();
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'a@example.test');
    await click(button('Add people'));
    expect(alerts()).toContain('Too many email lookups. Try again in 12 seconds.');
    // The address stays, so waiting and pressing the button again is all it takes.
    expect((document.querySelector('#member-emails') as HTMLTextAreaElement).value).toBe(
      'a@example.test',
    );
  });

  it('says it without a number when the server gave none', async () => {
    api.post.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many lookups.'));
    await renderPage();
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'a@example.test');
    await click(button('Add people'));
    expect(alerts()).toContain('Too many email lookups. Wait a moment and try again.');
  });

  it('says a refusal for a group they do not manage, and reads their groups again', async () => {
    api.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'You do not manage this group.'));
    await renderPage();
    const before = api.get.mock.calls.filter(([path]) => path === '/groups/managed').length;
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'a@example.test');
    await click(button('Add people'));
    expect(alerts()).toContain('You do not manage this group.');
    expect(
      api.get.mock.calls.filter(([path]) => path === '/groups/managed').length,
    ).toBeGreaterThan(before);
  });

  it('tells a person who has stopped managing every group, instead of an error', async () => {
    api.post.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Group not found'));
    await renderPage();
    await typeIntoTextarea(document.querySelector('#member-emails')!, 'a@example.test');
    await click(button('Add people'));
    expect(alerts().join(' ')).toContain('You no longer manage this group.');
  });

  it('removes a member after asking, and keeps a manager’s row free of Remove', async () => {
    api.delete.mockResolvedValue({ ok: true });
    await renderPage();
    // Ada is a member; Grace (this person) is a manager; only an administrator removes managers.
    expect(findButton('Remove Ada Lovelace')).toBeDefined();
    await click(button('Remove Ada Lovelace'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Remove Ada Lovelace?');
    await click(
      [...dialog()!.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Remove from group',
      )!,
    );
    expect(api.delete).toHaveBeenCalledWith('/groups/managed/group-1/members/user-1');
  });

  it('lets a manager leave, and says what that costs', async () => {
    api.delete.mockResolvedValue({ ok: true });
    await renderPage();
    expect(row('grace@example.test').textContent).toContain('Manager');
    await click(button('Leave Biology'));
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Leave Biology?');
    expect(dialog()?.textContent).toContain('no longer manage');
    await click(
      [...dialog()!.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Leave group',
      )!,
    );
    expect(api.delete).toHaveBeenCalledWith('/groups/managed/group-1/members/user-2');
  });

  it('does not offer to remove another manager', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me') return me;
      if (path === '/groups/managed') return { groups: managedGroups };
      return membersPage([
        member(),
        member({
          userId: 'user-3',
          name: 'Alan Turing',
          email: 'alan@example.test',
          role: 'manager',
        }),
      ]);
    });
    await renderPage();
    expect(findButton('Remove Alan Turing')).toBeUndefined();
    expect(row('alan@example.test').textContent).toContain('Manager');
  });

  it('offers a retry when the groups cannot be loaded', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me') return me;
      throw new ApiError(500, 'INTERNAL_ERROR', 'Database is away');
    });
    await renderPage();
    expect(alerts()).toContain('Your groups could not be loaded.');
  });
});
