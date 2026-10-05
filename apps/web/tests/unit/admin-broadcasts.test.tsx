// @vitest-environment happy-dom
import type { Broadcast } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminBroadcastsPage } from '../../src/routes/admin/broadcasts';
import { cleanup, findButton, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const broadcast: Broadcast = {
  id: 'b1',
  title: 'Walk maintenance on Sunday',
  body: 'Chat is read-only **from 06:00**. See [the status page](https://status.example.edu).',
  level: 'warning',
  audienceRoles: [],
  dismissable: true,
  published: true,
  startsAt: null,
  endsAt: null,
  active: true,
  dismissalCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
};

let root: Root | undefined;
beforeEach(() => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/broadcasts') return { broadcasts: [broadcast] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.clearAllMocks();
});

it('lets an auditor read each announcement’s message, formatted as shown (#87)', async () => {
  ({ root } = await renderAdmin(<AdminBroadcastsPage />, { role: 'auditor' }));
  expect(findButton('Edit Walk maintenance on Sunday')).toBeUndefined();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Chat is read-only from 06:00. See the status page.');
  expect(document.querySelector('a[href="https://status.example.edu/"]')).not.toBeNull();
});
