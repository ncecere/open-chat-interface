// @vitest-environment happy-dom
import {
  createInviteSchema,
  scheduledReportInputSchema,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuotaPolicyDialog } from '../../src/components/admin/quota-policy-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ApiError } from '../../src/lib/api-client';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { AdminPoliciesPage } from '../../src/routes/admin/policies';
import { AdminReportsPage } from '../../src/routes/admin/reports';
import { AuthenticationSettingsForm } from '../../src/routes/admin/settings/authentication-settings';
import { SmtpSettingsForm } from '../../src/routes/admin/settings/smtp-settings';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
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

  // Says what kind of value to enter (#347), not "missing or not the right kind".
  expect(fieldError('smtp-host')).toBe('SMTP host must be text.');
  // Only at the field: nothing beside Save changes.
  expect(alerts().filter((text) => text.includes('SMTP host'))).toHaveLength(1);
  // Corrected, it goes.
  await typeInto(input('smtp-host'), 'smtp2.example.edu');
  expect(fieldError('smtp-host')).toBeNull();
});

/** The reports page with no reports, whose API refuses a body as its real schema does. */
async function renderReports() {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports') return { reports: [] };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockImplementation(async (_path: string, body: unknown) => {
    const parsed = scheduledReportInputSchema.safeParse(body);
    if (!parsed.success) throw validationFailure(scheduledReportInputSchema, body);
    return { id: 'r1' };
  });
  ({ root } = await renderAdmin(<AdminReportsPage />));
}

it('Reports: a blank name and a bad recipient are both reported in one save (#318)', async () => {
  await renderReports();
  await typeInto(input('report-name'), ' ');
  await typeInto(input('report-recipients'), 'not-an-email');
  await click(button('Add report'));

  expect(fieldError('report-name')).toBe('Name is required.');
  expect(fieldError('report-recipients')).toBe('Recipients: not-an-email is not an email address.');

  // Correcting the recipients leaves the name's error where it is.
  await typeInto(input('report-recipients'), 'admin@northbrook.edu');
  expect(fieldError('report-recipients')).toBeNull();
  expect(fieldError('report-name')).toBe('Name is required.');
});

/** Presses the dialog's button named `label`. */
const submitIn = (label: string) =>
  click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!,
  );

/**
 * Whether the browser would stop this field's form with its own bubble: it
 * does so only when the form does not opt out with noValidate (#320).
 */
const browserWouldStop = (id: string) => {
  const control = input(id);
  return !control.form?.noValidate && !control.checkValidity();
};

it('Invitations: an expiry over 365 days is the app’s error at the field, not the browser’s bubble (#320)', async () => {
  api.get.mockResolvedValue({ invites: [] });
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(button('Create invitation'));
  await typeInto(input('invite-expiry'), '400');
  expect(browserWouldStop('invite-expiry')).toBe(false);
  await submitIn('Create invitation');
  expect(fieldError('invite-expiry')).toBe('Expires in days must be at most 365.');
  expect(api.post).not.toHaveBeenCalled();
});

const ACCOUNT_EXISTS =
  'An account with this email address already exists. Change its role on its account page instead.';

it('Invitations: an out-of-range expiry and an address that already has an account are both shown in one save (#346)', async () => {
  api.get.mockResolvedValue({ invites: [] });
  // As the API answers it: the schema's issue for the days and the address's own.
  const body = { email: 'm.bell@northbrook.edu', role: 'user', expiresInDays: 400 };
  api.post.mockRejectedValue(
    new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
      ...(validationFailure(createInviteSchema, body).details as unknown[]),
      { path: ['email'], message: ACCOUNT_EXISTS },
    ]),
  );
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(button('Create invitation'));
  await typeInto(input('invite-email'), 'm.bell@northbrook.edu');
  await typeInto(input('invite-expiry'), '400');
  await submitIn('Create invitation');

  // The server was asked, so it could add what only it knows.
  expect(api.post).toHaveBeenCalledWith('/admin/invites', body);
  expect(fieldError('invite-expiry')).toBe('Expires in days must be at most 365.');
  expect(fieldError('invite-email')).toBe(`Email: ${ACCOUNT_EXISTS}`);

  // Correcting the days clears only the days' error; the address's stays.
  await typeInto(input('invite-expiry'), '7');
  expect(fieldError('invite-expiry')).toBeNull();
  expect(fieldError('invite-email')).toBe(`Email: ${ACCOUNT_EXISTS}`);
});

it('Invitations: a refused form that the server cannot be asked about keeps its own errors, and one with no address is not sent (#346)', async () => {
  api.get.mockResolvedValue({ invites: [] });
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  await click(button('Create invitation'));
  // No address: nothing for the server to add.
  await typeInto(input('invite-expiry'), '400');
  await submitIn('Create invitation');
  expect(api.post).not.toHaveBeenCalled();
  expect(fieldError('invite-expiry')).toBe('Expires in days must be at most 365.');

  // An address, but the connection drops: the days' error is not replaced.
  api.post.mockRejectedValue(new TypeError('Failed to fetch'));
  await typeInto(input('invite-email'), 'new.person@northbrook.edu');
  await submitIn('Create invitation');
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(fieldError('invite-expiry')).toBe('Expires in days must be at most 365.');
  expect(alerts(dialog()!)).toEqual(['Expires in days must be at most 365.']);
});

it('Reports: a window of 0 days is the app’s error at the field (#320)', async () => {
  await renderReports();
  await typeInto(input('report-name'), 'Fix7 report');
  await typeInto(input('report-window'), '0');
  await typeInto(input('report-recipients'), 'admin@northbrook.edu');
  expect(browserWouldStop('report-window')).toBe(false);
  await click(button('Add report'));
  expect(fieldError('report-window')).toBe('Window (days) must be at least 1.');
});

it('Authentication › Session length: 0 days is the app’s error at the field (#320)', async () => {
  ({ root } = await renderAdmin(
    <AuthenticationSettingsForm
      initialSettings={{
        registrationMode: 'open',
        emailVerificationRequired: false,
        localAuthEnabled: true,
        sessionLifetimeDays: 30,
      }}
      smtpConfigured
    />,
  ));
  await typeInto(input('session-lifetime'), '0');
  expect(browserWouldStop('session-lifetime')).toBe(false);
  await click(button('Save changes'));
  expect(fieldError('session-lifetime')).toBe('Enter a whole number of days from 1 to 365.');
  expect(api.patch).not.toHaveBeenCalled();
  // Corrected, it goes and the value is saved.
  await typeInto(input('session-lifetime'), '14');
  expect(fieldError('session-lifetime')).toBeNull();
  api.patch.mockResolvedValue({ ok: true });
  await click(button('Save changes'));
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', { sessionLifetimeDays: 14 });
});

it('Usage budgets › New budget: an empty name and a negative limit are both at their fields (#320)', async () => {
  api.get.mockResolvedValue({ models: [] });
  ({ root } = await renderAdmin(
    <Dialog open>
      <QuotaPolicyDialog policy={null} onClose={() => undefined} />
    </Dialog>,
  ));
  await typeInto(input('policy-limit'), '-5');
  expect(browserWouldStop('policy-name')).toBe(false);
  await submitIn('Create budget');
  expect(fieldError('policy-name')).toBe('Name is required.');
  expect(fieldError('policy-limit')).toBe('Limit must be more than 0.');
  expect(api.post).not.toHaveBeenCalled();
  // Each goes with its own correction; the other stays.
  await typeInto(input('policy-name'), 'Fix7 budget');
  expect(fieldError('policy-name')).toBeNull();
  expect(fieldError('policy-limit')).toBe('Limit must be more than 0.');
});

it('Acceptable use › New version: a blank title and policy text are each at their field (#322)', async () => {
  api.get.mockResolvedValue({ policies: [] });
  ({ root } = await renderAdmin(<AdminPoliciesPage />));
  await click(button('New version'));
  // "Publish immediately" is off by default (#371), so this saves a draft.
  await typeInto(input('policy-title'), ' ');
  await typeIntoTextarea(document.getElementById('policy-body') as HTMLTextAreaElement, '   ');
  await submitIn('Save draft');

  expect(fieldError('policy-title')).toBe('Title is required.');
  expect(fieldError('policy-body')).toBe('Policy text is required.');
  // Nothing at the foot of the dialog.
  expect(alerts(dialog()!)).toEqual(['Title is required.', 'Policy text is required.']);
  expect(api.post).not.toHaveBeenCalled();
  // The publish switch is described by its hint (#310).
  expect(document.getElementById('policy-publish')?.getAttribute('aria-describedby')).toBe(
    'policy-publish-hint',
  );
});
