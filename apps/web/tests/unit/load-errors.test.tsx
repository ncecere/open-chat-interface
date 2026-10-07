// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminAuditPage } from '../../src/routes/admin/audit';
import { AdminUsersPage } from '../../src/routes/admin/users';
import { SettingsAttachmentsPage } from '../../src/routes/settings/attachments';
import { SettingsConnectorsPage } from '../../src/routes/settings/connectors';
import { SettingsHistoryPage } from '../../src/routes/settings/history';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { alerts, button, cleanup, click, findButton, renderAdmin } from './admin-test-utils';

/**
 * #245: a list that failed to load said different things on each page. The
 * Users subtitle still said "Loading accounts..." beside the error; the
 * audit log's error was in no live region, so a screen reader heard
 * nothing; History, Memory and Connectors said "Reload the page" with no
 * button; Attachments' error was not announced. Each now says one thing, announced once, with Try again, which
 * loads the list. The real pages and query cache; the server fails first.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

/** The list request answers 500 until `healthy` is set. */
let healthy: boolean;
let root: Root | undefined;
beforeEach(() => {
  healthy = false;
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return { user: { id: 'u1', name: 'Ada', role: 'admin' }, preferences: {}, features: {} };
    if (path === '/projects') return { projects: [] };
    if (path === '/me/imports') return { imports: [] };
    const list = /^\/(admin\/users|admin\/audit|threads\?|memory$|connectors$|attachments$)/.test(
      path,
    );
    if (list && !healthy) throw new ApiError(500, 'INTERNAL_ERROR', 'Database unavailable.');
    if (path.startsWith('/admin/users'))
      return { users: [], total: 0, page: 1, pageSize: 25, pageCount: 1 };
    if (path.startsWith('/admin/audit/actions')) return { actions: [] };
    if (path.startsWith('/admin/audit')) return { entries: [], total: 0 };
    if (path.startsWith('/threads?')) return { threads: [], nextCursor: null };
    if (path === '/memory')
      return {
        enabled: true,
        available: true,
        entries: [],
        limits: { maxEntries: 50, maxChars: 500 },
      };
    if (path === '/connectors') return { connectors: [] };
    if (path === '/attachments') return { attachments: [] };
    if (path === '/attachments/usage')
      return {
        liveBytes: 0,
        liveFileCount: 0,
        pendingBytes: 0,
        pendingFileCount: 0,
        artifactBytes: 0,
        breakdown: {
          chatFiles: { bytes: 0, count: 0 },
          projectFiles: { bytes: 0, count: 0 },
          artifacts: { bytes: 0, count: 0 },
        },
        maxTotalBytes: null,
        maxFileCount: null,
        maxFileBytes: null,
      };
    return {};
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const PAGES: [string, ReactNode, string, string][] = [
  ['Users', <AdminUsersPage key="u" />, '/admin/users', 'Accounts could not be loaded.'],
  ['Audit log', <AdminAuditPage key="a" />, '/admin/audit', 'Audit events could not be loaded.'],
  [
    'History',
    <SettingsHistoryPage key="h" />,
    '/settings/history',
    'Your conversations could not be loaded.',
  ],
  ['Memory', <SettingsMemoryPage key="m" />, '/settings/memory', 'Memory could not be loaded.'],
  [
    'Connectors',
    <SettingsConnectorsPage key="c" />,
    '/settings/connectors',
    'Connectors could not be loaded.',
  ],
  [
    'Attachments',
    <SettingsAttachmentsPage key="f" />,
    '/settings/attachments',
    'Attachments could not be loaded.',
  ],
];

describe('a list that could not be loaded (#245)', () => {
  it.each(PAGES)('%s: announces one error and offers Try again', async (_, page, path, error) => {
    ({ root } = await renderAdmin(page, { path }));
    expect(alerts()).toEqual([error]);
    expect(document.body.textContent).not.toMatch(/Loading|Reload the page/);

    healthy = true;
    await click(button('Try again'));
    expect(alerts()).toEqual([]);
    expect(findButton('Try again')).toBeUndefined();
  });
});
