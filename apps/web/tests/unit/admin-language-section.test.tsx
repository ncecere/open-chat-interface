// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { LanguageSection } from '../../src/routes/admin/branding/language-section';
import { button, cleanup, click, renderAdmin } from './admin-test-utils';

// Admin → Branding → Language: which languages people may choose and the
// default. English is always on; the default must be one of the enabled ones.

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
beforeEach(() => {
  api.patch.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (
  language?: { default: string | null; enabled: string[] },
  role?: 'admin' | 'auditor',
) => {
  ({ root } = await renderAdmin(<LanguageSection language={language as never} />, { role }));
};
const checkbox = (label: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    input.closest('label')?.textContent?.startsWith(label),
  )!;

it('shows English on and always on, the others off, for an instance that never set it', async () => {
  await render(undefined);
  expect(checkbox('English').checked).toBe(true);
  expect(checkbox('English').disabled).toBe(true);
  expect(checkbox('Español (beta)').checked).toBe(false);
  expect(checkbox('العربية (beta)').checked).toBe(false);
  expect(document.body.textContent).toContain('administration console stays in English');
  expect(button('Save language').disabled).toBe(true);
});

it('saves the enabled languages and the default as one change', async () => {
  await render({ default: null, enabled: ['en'] });
  await click(checkbox('Español'));
  expect(button('Save language').disabled).toBe(false);
  await click(document.querySelector<HTMLElement>('button[role="combobox"]')!);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === 'Español (beta)',
  );
  expect(option).toBeDefined();
  await click(option!);
  await click(button('Save language'));
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
    language: { enabled: ['en', 'es'], default: 'es' },
  });
  expect(document.body.textContent).toContain('Language settings saved.');
  expect(button('Save language').disabled).toBe(true);
});

it('drops the default when its language is switched off', async () => {
  await render({ default: 'es', enabled: ['en', 'es'] });
  expect(document.querySelector('button[role="combobox"]')?.textContent).toBe('Español (beta)');
  await click(checkbox('Español'));
  expect(document.querySelector('button[role="combobox"]')?.textContent).toBe('Follow the browser');
  await click(button('Save language'));
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
    language: { enabled: ['en'], default: null },
  });
});

it('says why when the server refuses', async () => {
  api.patch.mockRejectedValue(
    new ApiError(
      422,
      'VALIDATION_FAILED',
      'The default language must be one of the enabled languages.',
    ),
  );
  await render({ default: null, enabled: ['en'] });
  await click(checkbox('Español'));
  await click(button('Save language'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('default language');
  expect(button('Save language').disabled).toBe(false);
});

it('is read-only for an auditor', async () => {
  await render({ default: null, enabled: ['en'] }, 'auditor');
  // The section's own fieldset is disabled for a read-only viewer.
  expect(checkbox('Español').closest('fieldset[disabled]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Save language');
});
