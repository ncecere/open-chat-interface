// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { alerts, cleanup, click, dialog, renderAdmin, typeInto } from './admin-test-utils';

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
