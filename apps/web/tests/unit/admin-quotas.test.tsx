// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminQuotasPage } from '../../src/routes/admin/quotas';
import { button, buttonNames, cleanup, click, dialog, renderAdmin } from './admin-test-utils';

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
  api.get.mockImplementation(async (path: string) =>
    path === '/admin/quotas' ? { policies: [] } : { models: [] },
  );
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it('calls them usage budgets throughout, as the page and navigation do (#182)', async () => {
  ({ root } = await renderAdmin(<AdminQuotasPage />));
  const text = document.body.textContent ?? '';
  expect(text).toContain('No usage budgets yet.');
  expect(text).not.toMatch(/quota polic/i);

  await click(button('New budget'));
  expect(dialog()?.querySelector('h2')?.textContent).toBe('New budget');
  expect(buttonNames(dialog()!)).toContain('Create budget');
  expect(dialog()?.textContent).not.toMatch(/\bpolicy\b/i);
});
