// @vitest-environment happy-dom
import type { InstanceSettings } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderCapacitySection } from '../../src/components/admin/capacity-limits';
import { ProviderFormDialog } from '../../src/components/admin/provider-form-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ApiError } from '../../src/lib/api-client';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { GeneralSettings } from '../../src/routes/admin/settings/general-settings';
import { SmtpSettingsForm } from '../../src/routes/admin/settings/smtp-settings';
import { StorageSettingsForm } from '../../src/routes/admin/storage/storage-settings-form';
import {
  button,
  cleanup,
  click,
  dialog,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';

// The forms #283 did not reach (#302): an error is shown under its field, in
// error colour, and the field is marked invalid and described by it.

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

/**
 * The error shown at a control, as a screen reader reaches it: the control
 * is marked invalid and described by an alert in its field, in error colour.
 */
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
  expect(control.parentElement?.contains(error)).toBe(true);
  return error?.textContent ?? null;
}

const submitIn = (scope: ParentNode, label: string) =>
  click(
    [...scope.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!,
  );

it('General › Tool step limit: the range error is at the field, not beside Save', async () => {
  const settings = {
    defaultSystemPrompt: null,
    defaultEffort: 'instant',
    maxToolSteps: 8,
    autoCompact: true,
    diagramGuidance: true,
    storage: { driver: 'local' },
    features: { shareLinks: false, temporaryChat: true, branching: true, attachments: true },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<GeneralSettings settings={settings} />));
  const steps = document.getElementById('max-tool-steps') as HTMLInputElement;
  await typeInto(steps, '21');
  await submitIn(steps.closest('form')!, 'Save changes');
  expect(fieldError('max-tool-steps')).toBe('Enter a whole number from 1 to 20.');
  expect(api.patch).not.toHaveBeenCalled();
  await typeInto(steps, '12');
  expect(fieldError('max-tool-steps')).toBeNull();
});

it('Storage › Allowed MIME types: the error is in error colour under the field, with its hint kept', async () => {
  ({ root } = await renderAdmin(
    <StorageSettingsForm
      initialSettings={{
        driver: 'local',
        localPath: '/data/attachments',
        maxFileBytes: 10_485_760,
        maxFilesPerMessage: 5,
        allowedMimeTypes: ['image/png'],
        s3: {
          bucket: 'attachments',
          region: 'us-east-1',
          endpoint: null,
          accessKeyId: 'access-id',
          forcePathStyle: false,
          hasCredential: true,
        },
      }}
    />,
    { path: '/admin/storage?tab=uploads' },
  ));
  const types = document.getElementById('allowed-mime-types') as HTMLTextAreaElement;
  await typeIntoTextarea(types, 'image/png\nnot a mime');
  await click(button('Save changes'));
  expect(fieldError('allowed-mime-types')).toBe('“not a mime” is not a valid MIME type.');
  expect(types.parentElement?.textContent).toContain('One MIME type per line');
  expect(api.patch).not.toHaveBeenCalled();
});

it('Invitations: an address that already has an account is shown at the Email field', async () => {
  api.get.mockResolvedValue({ invites: [] });
  const message =
    'An account with this email address already exists. Change its role on its account page instead.';
  // As the API now refuses it: a conflict about the email field.
  api.post.mockRejectedValue(
    new ApiError(409, 'CONFLICT', message, [{ path: ['email'], message }]),
  );
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(button('Create invitation'));
  await typeInto(document.getElementById('invite-email') as HTMLInputElement, 'm.bell@example.edu');
  await submitIn(dialog()!, 'Create invitation');
  expect(fieldError('invite-email')).toBe(`Email: ${message}`);
  await typeInto(document.getElementById('invite-email') as HTMLInputElement, 'new@example.edu');
  expect(fieldError('invite-email')).toBeNull();
});

it('Email delivery › SMTP host: the error is under the field, not in place of its hint', async () => {
  ({ root } = await renderAdmin(
    <SmtpSettingsForm
      initialSettings={{
        configured: true,
        host: 'mail.example.edu',
        port: 587,
        secure: false,
        fromAddress: 'oci@example.edu',
        hasUsername: false,
        hasPassword: false,
      }}
    />,
  ));
  await typeInto(document.getElementById('smtp-port') as HTMLInputElement, '70000');
  await click(button('Save changes'));
  expect(fieldError('smtp-port')).not.toBeNull();
  expect(document.getElementById('smtp-port')?.parentElement?.textContent).toContain(
    'Commonly 465 or 587.',
  );
});

it('Providers › Capacity: the longest-wait error is at its field', async () => {
  api.get.mockResolvedValue({
    queue: {
      maxWaitSeconds: 120,
      rolePriority: { admin: 'normal', auditor: 'normal', user: 'normal', restricted: 'normal' },
    },
    enforcement: 'shared',
    providers: [],
  });
  ({ root } = await renderAdmin(<ProviderCapacitySection />));
  await typeInto(document.getElementById('capacity-max-wait') as HTMLInputElement, '2');
  await click(button('Save changes'));
  expect(fieldError('capacity-max-wait')).toBe(
    'The longest wait must be between 5 and 1,800 seconds.',
  );
  expect(api.put).not.toHaveBeenCalled();
});

it('Add provider: a missing base URL and API key refused by the API are each at their field', async () => {
  // As the API refuses it: the configuration rules, each with its field (#283).
  api.post.mockRejectedValue(
    new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
      {
        code: 'custom',
        path: ['baseUrl'],
        message: 'OpenAI-compatible providers require a base URL.',
      },
      { code: 'custom', path: ['label'], message: 'A display name is required.' },
    ]),
  );
  ({ root } = await renderAdmin(
    <Dialog open>
      <ProviderFormDialog provider={null} onClose={() => {}} />
    </Dialog>,
  ));
  await click(document.getElementById('provider-kind')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'OpenAI-compatible',
    )!,
  );
  // Spaces pass the browser's own required check; the form trims them away.
  await typeInto(document.getElementById('provider-base-url') as HTMLInputElement, '   ');
  await submitIn(dialog()!, 'Add provider');
  expect(fieldError('provider-base-url')).toBe(
    'Base URL: OpenAI-compatible providers require a base URL.',
  );
  expect(fieldError('provider-label')).toBe('Display name: A display name is required.');
});
