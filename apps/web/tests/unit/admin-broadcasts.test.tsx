// @vitest-environment happy-dom
import type { Broadcast } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../src/lib/utils';
import {
  AdminBroadcastsPage,
  broadcastState,
  broadcastWindow,
} from '../../src/routes/admin/broadcasts';
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
import { untitledTruncations } from './truncation';

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

it('clears "the end time must be after the start time" once Ends is moved later (#217)', async () => {
  ({ root } = await renderAdmin(<AdminBroadcastsPage />));
  await click(button('New announcement'));
  await typeInto(document.getElementById('broadcast-title') as HTMLInputElement, 'Walk3');
  await typeIntoTextarea(
    document.getElementById('broadcast-body') as HTMLTextAreaElement,
    'Maintenance.',
  );
  await typeInto(
    document.getElementById('broadcast-starts') as HTMLInputElement,
    '2026-10-22T10:00',
  );
  const ends = document.getElementById('broadcast-ends') as HTMLInputElement;
  await typeInto(ends, '2026-10-20T10:00');
  await click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create announcement',
    )!,
  );
  // "Ends", as the field is labelled, not "Ends at" (#228).
  expect(alerts(dialog()!)).toEqual(['Ends: The end time must be after the start time.']);
  await typeInto(ends, '2026-10-24T10:00');
  expect(alerts(dialog()!)).toEqual([]);
});

it('closes an unchanged edit without saving, so nothing is audited (#287)', async () => {
  ({ root } = await renderAdmin(<AdminBroadcastsPage />));
  await click(button('Edit Walk maintenance on Sunday'));
  await click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Save changes',
    )!,
  );
  expect(api.put).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();

  // A real change is still saved.
  api.put.mockResolvedValueOnce({ ok: true });
  await click(button('Edit Walk maintenance on Sunday'));
  await typeInto(document.getElementById('broadcast-title') as HTMLInputElement, 'Walk renamed');
  await click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Save changes',
    )!,
  );
  expect(api.put).toHaveBeenCalledWith(
    '/admin/broadcasts/b1',
    expect.objectContaining({ title: 'Walk renamed' }),
  );
});

it('says when a scheduled announcement shows, to auditors too (#227)', async () => {
  const startsAt = new Date(Date.now() + 15 * 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 17 * 86_400_000).toISOString();
  api.get.mockImplementation(async () => ({
    broadcasts: [{ ...broadcast, active: false, startsAt, endsAt }],
  }));
  ({ root } = await renderAdmin(<AdminBroadcastsPage />, { role: 'auditor' }));
  const text = document.body.textContent ?? '';
  expect(text).toContain('scheduled');
  expect(text).toContain(`${formatDateTime(startsAt)} – ${formatDateTime(endsAt)}`);
});

it('names the window and state of every kind of announcement (#227)', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const at = (iso: string) => formatDateTime(iso);
  expect(broadcastWindow({ startsAt: null, endsAt: null })).toBeNull();
  expect(broadcastWindow({ startsAt: '2026-10-20T10:00:00Z', endsAt: null })).toBe(
    `From ${at('2026-10-20T10:00:00Z')}`,
  );
  expect(broadcastWindow({ startsAt: null, endsAt: '2026-10-22T10:00:00Z' })).toBe(
    `Until ${at('2026-10-22T10:00:00Z')}`,
  );
  const published = { active: false, published: true };
  expect(broadcastState({ ...published, endsAt: '2026-10-22T10:00:00Z' }, now)).toBe('scheduled');
  // Published, past its end: no longer "scheduled".
  expect(broadcastState({ ...published, endsAt: '2026-10-01T10:00:00Z' }, now)).toBe('ended');
  expect(broadcastState({ active: false, published: false, endsAt: null }, now)).toBe('draft');
  expect(broadcastState({ active: true, published: true, endsAt: null }, now)).toBe('showing');
});

it('lets an auditor read each announcement’s message, formatted as shown (#87)', async () => {
  ({ root } = await renderAdmin(<AdminBroadcastsPage />, { role: 'auditor' }));
  expect(findButton('Edit Walk maintenance on Sunday')).toBeUndefined();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Chat is read-only from 06:00. See the status page.');
  expect(document.querySelector('a[href="https://status.example.edu/"]')).not.toBeNull();
});

it('gives the title and audience line a tooltip, as a phone cuts them short (#130)', async () => {
  ({ root } = await renderAdmin(<AdminBroadcastsPage />, { role: 'auditor' }));
  expect(document.body.textContent).toContain('Walk maintenance on Sunday');
  expect(untitledTruncations()).toEqual([]);
});
