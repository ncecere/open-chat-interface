// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminAuditPage } from '../../src/routes/admin/audit';
import { AdminUsersPage } from '../../src/routes/admin/users';
import { button, cleanup, click, findButton, renderAdmin, typeInto } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const EVENT = {
  id: 'event-1',
  organizationId: 'org',
  actorUserId: 'admin-1',
  actorEmail: 'admin@example.test',
  action: 'user.update',
  targetType: 'user',
  targetId: 'demo-user-009',
  metadata: { banned: true },
  ipAddress: null,
  createdAt: '2026-10-05T12:00:00.000Z',
};

let root: Root | undefined;
let listing: { entries: (typeof EVENT)[]; total: number };
beforeEach(() => {
  listing = { entries: [EVENT], total: 1 };
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/audit/actions') return { actions: ['user.update'] };
    if (path.startsWith('/admin/audit?')) return listing;
    if (path.startsWith('/admin/users?')) return { users: [], total: 0 };
    if (path.startsWith('/admin/views')) return { views: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  window.history.replaceState(null, '', '/');
});

const listCalls = () =>
  api.get.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith('/admin/audit?'))
    .map((path) => new URLSearchParams(path.split('?')[1]));

it("narrows the log to one account's events from the account page's link", async () => {
  window.history.replaceState(
    null,
    '',
    '/admin/audit?user=demo-user-009&userEmail=o.fitzgerald%40northbrook.edu',
  );
  ({ root } = await renderAdmin(<AdminAuditPage />, { path: '/admin/audit' }));

  // By id (actor or target), not by searching the email, which misses every
  // action an admin took on the account.
  const params = listCalls().at(-1);
  expect(params?.get('userId')).toBe('demo-user-009');
  expect(params?.get('search')).toBeNull();
  expect(document.body.textContent).toContain('Events by or about');
  expect(document.body.textContent).toContain('o.fitzgerald@northbrook.edu');

  const clear = findButton('Stop showing only events by or about o.fitzgerald@northbrook.edu');
  expect(clear).toBeTruthy();
  if (clear) await click(clear);
  expect(listCalls().at(-1)?.get('userId')).toBeNull();
  expect(document.body.textContent).not.toContain('Events by or about');
});

it('says nothing matched, not that the log is empty, when filters exclude every event', async () => {
  ({ root } = await renderAdmin(<AdminAuditPage />, { path: '/admin/audit' }));
  listing = { entries: [], total: 0 };
  const search = document.getElementById('audit-search') as HTMLInputElement;
  await typeInto(search, 'walk');

  expect(document.body.textContent).toContain('No events match your filters.');
  expect(document.body.textContent).not.toContain('No audit events yet.');
  await click(button('Clear filters'));
  expect(search.value).toBe('');
});

it('still says the log is empty when there are no events and no filters', async () => {
  listing = { entries: [], total: 0 };
  ({ root } = await renderAdmin(<AdminAuditPage />, { path: '/admin/audit' }));
  expect(document.body.textContent).toContain('No audit events yet.');
});

it('says no accounts match instead of showing bare table headers', async () => {
  ({ root } = await renderAdmin(<AdminUsersPage />, { path: '/admin/users' }));
  expect(document.querySelector('table')).toBeNull();
  expect(document.body.textContent).toContain('No accounts match these filters.');
  expect(findButton('Clear filters')).toBeTruthy();
});
