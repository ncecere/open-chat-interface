// @vitest-environment happy-dom
import type { UsagePolicy } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminPoliciesPage } from '../../src/routes/admin/policies';
import { button, cleanup, click, dialog, findButton, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const published: UsagePolicy = {
  id: 'policy-1',
  version: 1,
  title: 'Acceptable use',
  body: 'Be kind to the machines.',
  publishedAt: '2026-10-01T00:00:00.000Z',
  acceptanceCount: 12,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const draft: UsagePolicy = {
  id: 'policy-2',
  version: 2,
  title: 'Walk AUP draft',
  body: 'Be kind. Typo: recieve.',
  publishedAt: null,
  acceptanceCount: 0,
  createdAt: '2026-10-05T00:00:00.000Z',
};

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ policies: [draft, published] });
  api.post.mockReset().mockResolvedValue({ ok: true });
  api.patch.mockReset().mockResolvedValue({ ok: true });
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it('lets an auditor read the wording of any version', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />, { role: 'auditor' }));

  await click(button('View Acceptable use v1'));
  expect(dialog()?.textContent).toContain('Be kind to the machines.');
  expect(dialog()?.textContent).toContain('accepted by 12');
  // Read-only: no way to change a draft.
  expect(findButton('Edit draft Walk AUP draft v2')).toBeUndefined();
  expect(findButton('Delete draft Walk AUP draft v2')).toBeUndefined();
});

it('rewords a draft but offers no edit for a published version', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  expect(findButton('Edit draft Acceptable use v1')).toBeUndefined();

  await click(button('Edit draft Walk AUP draft v2'));
  const body = document.getElementById('policy-body') as HTMLTextAreaElement;
  expect(body.value).toBe('Be kind. Typo: recieve.');
  // Publishing a draft is a separate, confirmed step.
  expect(document.getElementById('policy-publish')).toBeNull();
  await click(button('Save draft'));

  expect(api.patch).toHaveBeenCalledWith('/admin/policies/policy-2', {
    title: 'Walk AUP draft',
    body: 'Be kind. Typo: recieve.',
  });
});

it('deletes a draft after confirmation', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await click(button('Delete draft Walk AUP draft v2'));
  expect(api.delete).not.toHaveBeenCalled();

  await click(button('Delete draft'));
  expect(api.delete).toHaveBeenCalledWith('/admin/policies/policy-2');
});

it('asks before publishing, since everyone must accept again', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await click(button('Publish'));
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('cannot be changed or withdrawn');

  const confirm = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === 'Publish',
  );
  if (confirm) await click(confirm);
  expect(api.post).toHaveBeenCalledWith('/admin/policies/policy-2/publish');
});
