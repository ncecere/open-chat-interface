// @vitest-environment happy-dom
import type { InstanceSettings } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SmtpSettingsForm } from '../../src/routes/admin/settings/smtp-settings';
import { button, cleanup, click, renderAdmin, typeInto } from './admin-test-utils';

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

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.clearAllMocks();
});

const smtp: InstanceSettings['smtp'] = {
  configured: true,
  host: 'mail.example.edu',
  port: 587,
  secure: false,
  fromAddress: 'oci@example.edu',
  hasUsername: true,
  hasPassword: false,
};

it('says what is stored and sends a test email (#115)', async () => {
  ({ root } = await renderAdmin(<SmtpSettingsForm initialSettings={smtp} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain('A username is stored.');
  expect(text).toContain('No password is stored.');
  expect(text).not.toContain('does not report whether');
  // The page has a working test button, so it does not say it cannot test (#182).
  expect(text).not.toContain('does not test the connection or send a test message');
  expect(text).toContain('Use Send test email below to confirm messages arrive');

  api.post.mockResolvedValue({ ok: false, message: 'The mail server refused: Invalid login: 535' });
  await click(button('Send test email'));
  expect(api.post).toHaveBeenCalledWith('/admin/settings/smtp/test', {});
  expect(document.body.textContent).toContain('Invalid login: 535');

  // Unsaved edits are not what the test would use: it says so.
  await typeInto(document.getElementById('smtp-host') as HTMLInputElement, 'other.example.edu');
  const send = button('Send test email');
  expect(send.disabled).toBe(true);
  expect(document.getElementById(send.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    'Save changes before testing them.',
  );
});
