// @vitest-environment happy-dom
import { updateInstanceSettingsSchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SmtpSettingsForm } from '../../src/routes/admin/settings/smtp-settings';
import {
  alerts,
  button,
  cleanup,
  click,
  renderAdmin,
  typeInto,
  validationFailure,
} from './admin-test-utils';

// Forms walk 7 found reporting a problem at the foot, one per save, or in the
// browser's own bubble (#317, #318, #320, #321, #322): every problem in one
// save, each under its field, which is marked invalid and described by it.

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
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

/** The error shown at a control, as a screen reader reaches it: null when it has none. */
function fieldError(id: string): string | null {
  const control = document.getElementById(id)!;
  const error = document.getElementById(`${id}-error`);
  if (control.getAttribute('aria-invalid') !== 'true') {
    expect(error).toBeNull();
    return null;
  }
  expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(`${id}-error`);
  expect(error?.getAttribute('role')).toBe('alert');
  expect(error?.className).toContain('text-[var(--danger)]');
  // Under the control, in the same field.
  expect(control.parentElement?.contains(error)).toBe(true);
  return error?.textContent ?? null;
}

const SMTP = {
  configured: true,
  host: 'mail.example.edu',
  port: 587,
  secure: false,
  fromAddress: 'oci@example.edu',
  hasUsername: false,
  hasPassword: false,
};

it('Email delivery: a bad port and a bad From address are both reported in one save, at their fields (#317)', async () => {
  ({ root } = await renderAdmin(<SmtpSettingsForm initialSettings={SMTP} />));
  await typeInto(input('smtp-port'), '99999');
  await typeInto(input('smtp-from-address'), 'not-an-email');
  await click(button('Save changes'));

  expect(fieldError('smtp-port')).toBe('Port must be a whole number from 1 to 65535.');
  expect(fieldError('smtp-from-address')).toBe(
    'Use an email address, optionally with a name: Help Desk <help@example.edu>.',
  );
  expect(api.patch).not.toHaveBeenCalled();

  // The port corrected, the address still stops the save, at its field.
  await typeInto(input('smtp-port'), '1025');
  await click(button('Save changes'));
  expect(fieldError('smtp-port')).toBeNull();
  expect(fieldError('smtp-from-address')).not.toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
});

it('Email delivery: an address with a name is accepted (#317)', async () => {
  api.patch.mockResolvedValue({ ok: true });
  ({ root } = await renderAdmin(<SmtpSettingsForm initialSettings={SMTP} />));
  await typeInto(input('smtp-from-address'), 'Help Desk <help@example.edu>');
  await click(button('Save changes'));
  expect(fieldError('smtp-from-address')).toBeNull();
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
    smtp: { fromAddress: 'Help Desk <help@example.edu>' },
  });
});

it('Email delivery: a field the API refuses is shown at that field, not at the foot (#317)', async () => {
  // The real schema's refusal of a host, as the API sends it.
  api.patch.mockRejectedValue(
    validationFailure(updateInstanceSettingsSchema, { smtp: { host: 5 } }),
  );
  ({ root } = await renderAdmin(<SmtpSettingsForm initialSettings={SMTP} />));
  await typeInto(input('smtp-host'), 'smtp.example.edu');
  await click(button('Save changes'));

  expect(fieldError('smtp-host')).toBe('SMTP host is missing or not the right kind of value.');
  // Only at the field: nothing beside Save changes.
  expect(alerts().filter((text) => text.includes('SMTP host'))).toHaveLength(1);
  // Corrected, it goes.
  await typeInto(input('smtp-host'), 'smtp2.example.edu');
  expect(fieldError('smtp-host')).toBeNull();
});
