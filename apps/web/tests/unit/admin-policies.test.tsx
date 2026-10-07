// @vitest-environment happy-dom
import type { UsagePolicy } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminPoliciesPage } from '../../src/routes/admin/policies';
import {
  alerts,
  button,
  buttonNames,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';

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

it('clears the error once the policy text is filled in (#217)', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await click(button('New version'));
  const body = document.getElementById('policy-body') as HTMLTextAreaElement;
  await typeIntoTextarea(body, '   ');
  await click(button('Save draft'));
  // In the form's words, not the API's "Body" (#228).
  expect(alerts(dialog()!)).toEqual(['Policy text is required.']);
  expect(api.post).not.toHaveBeenCalled();
  await typeIntoTextarea(body, 'Be kind to the machines, please.');
  expect(alerts(dialog()!)).toEqual([]);
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
  await click(button('Publish Walk AUP draft v2'));
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('cannot be changed or withdrawn');

  const confirm = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === 'Publish',
  );
  if (confirm) await click(confirm);
  expect(api.post).toHaveBeenCalledWith('/admin/policies/policy-2/publish');
});

it("names each version's Publish button for its version (#175)", async () => {
  api.get.mockResolvedValue({
    policies: [{ ...draft, id: 'policy-3', version: 3, title: 'Walk AUP second draft' }, draft],
  });
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  expect(buttonNames().filter((name) => name.startsWith('Publish'))).toEqual([
    'Publish Walk AUP second draft v3',
    'Publish Walk AUP draft v2',
  ]);
});

const submitButton = () =>
  [...dialog()!.querySelectorAll('button[type="submit"]')].at(0) as HTMLButtonElement;

async function fillNewVersion(title: string) {
  await click(button('New version'));
  await typeInto(document.getElementById('policy-title') as HTMLInputElement, title);
  await typeIntoTextarea(
    document.getElementById('policy-body') as HTMLTextAreaElement,
    'Be kind to the machines, please.',
  );
}

it('saves a draft by default: Publish immediately starts off (#371)', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await fillNewVersion('Walk9 AUP');
  expect(document.getElementById('policy-publish')?.getAttribute('aria-checked')).toBe('false');
  expect(submitButton().textContent).toBe('Save draft');

  await click(submitButton());
  expect(api.post).toHaveBeenCalledWith('/admin/policies', {
    title: 'Walk9 AUP',
    body: 'Be kind to the machines, please.',
    publish: false,
  });
});

it('asks before publishing from New version, naming the title and version, and says it cannot be undone (#371)', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await fillNewVersion('Walk9 AUP');
  await click(document.getElementById('policy-publish')!);
  // Before: this button published at once, with no question.
  expect(submitButton().textContent).toBe('Publish version…');

  await click(submitButton());
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Publish “Walk9 AUP” as version 3?');
  expect(dialog()?.textContent).toContain('cannot be changed or withdrawn');
  expect(submitButton().textContent).toBe('Publish version 3');

  // Back changes nothing; the form is still there, the switch still on.
  await click(button('Back'));
  expect(api.post).not.toHaveBeenCalled();
  expect(document.getElementById('policy-title')).not.toBeNull();

  await click(submitButton());
  await click(submitButton());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/admin/policies', {
    title: 'Walk9 AUP',
    body: 'Be kind to the machines, please.',
    publish: true,
  });
});

it('names the policy and version in the confirmation for publishing a draft from the list (#371)', async () => {
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await click(button('Publish Walk AUP draft v2'));
  expect(dialog()?.textContent).toContain('Publish “Walk AUP draft” as v2?');
});
