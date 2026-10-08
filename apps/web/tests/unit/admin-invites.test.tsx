// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { formatDateTime } from '../../src/lib/utils';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { alerts, cleanup, click, dialog, renderAdmin, settle, typeInto } from './admin-test-utils';

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
  api.get.mockResolvedValue({ invites: [] });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const submit = () =>
  click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create invitation',
    )!,
  );

it('clears a refused invitation’s error once the email is changed (#178)', async () => {
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create invitation',
    )!,
  );
  const email = document.getElementById('invite-email') as HTMLInputElement;
  await typeInto(email, 'm.bell@northbrook.edu');
  api.post.mockRejectedValueOnce(
    new ApiError(409, 'CONFLICT', 'An account with this email address already exists'),
  );
  await submit();
  expect(alerts(dialog()!)).toEqual(['An account with this email address already exists']);

  await typeInto(email, 'walk3-new@northbrook.edu');
  expect(alerts(dialog()!)).toEqual([]);
});

async function createFor(address: string) {
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create invitation',
    )!,
  );
  await typeInto(document.getElementById('invite-email') as HTMLInputElement, address);
  await submit();
}

it('does not show a link for an invitation that was emailed (#214)', async () => {
  api.post.mockResolvedValueOnce({ id: 'inv-1', emailDelivered: true });
  await createFor('m.bell@northbrook.edu');

  const text = dialog()!.textContent ?? '';
  expect(text).toContain(
    'Invitation emailed to m.bell@northbrook.edu. The link was sent only to that address, so it is not shown here.',
  );
  // Nothing to copy, and no field holding a link.
  expect(dialog()!.querySelector('input')).toBeNull();
  expect(dialog()!.querySelector('[aria-label="One-time invite URL"]')).toBeNull();
  expect(
    [...dialog()!.querySelectorAll('button')].some((button) =>
      /copy/i.test(button.textContent ?? ''),
    ),
  ).toBe(false);
  expect(text).not.toContain('could not be delivered');
});

it('keeps the link to copy, and warns, when the email was not delivered (#214)', async () => {
  api.post.mockResolvedValueOnce({
    id: 'inv-2',
    emailDelivered: false,
    url: 'https://oci.example.test/auth/accept-invite#token=abc',
  });
  await createFor('m.bell@northbrook.edu');

  const url = dialog()!.querySelector(
    'input[aria-label="One-time invite URL"]',
  ) as HTMLInputElement;
  expect(url.value).toBe('https://oci.example.test/auth/accept-invite#token=abc');
  expect(
    [...dialog()!.querySelectorAll('button')].some((button) => button.textContent === 'Copy link'),
  ).toBe(true);
  expect(dialog()!.textContent).toContain(
    'The email could not be delivered to m.bell@northbrook.edu. Share the link manually.',
  );
  expect(dialog()!.textContent).not.toContain('not shown here');
});

it('says in the list which invitations were emailed, and when (#214)', async () => {
  const base = {
    role: 'user',
    expiresAt: null,
    redeemedAt: null,
    redeemedByUserId: null,
    createdAt: '2026-10-01T12:00:00.000Z',
  };
  api.get.mockResolvedValue({
    invites: [
      { ...base, id: 'a', email: 'emailed@northbrook.edu', emailedAt: '2026-10-01T12:00:05.000Z' },
      { ...base, id: 'b', email: 'by-hand@northbrook.edu', emailedAt: null },
    ],
  });
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await settle();
  // Each row's text sits in the column holding its address and its details.
  const rowFor = (address: string) =>
    [...document.querySelectorAll('dl')]
      .map((details) => details.parentElement?.textContent ?? '')
      .find((text) => text.includes(address)) ?? '';
  expect(rowFor('emailed@northbrook.edu')).toContain(
    `Emailed${formatDateTime('2026-10-01T12:00:05.000Z')}`,
  );
  expect(rowFor('by-hand@northbrook.edu')).not.toContain('Emailed');
});
