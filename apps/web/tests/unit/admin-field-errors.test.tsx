// @vitest-environment happy-dom
import {
  type AdminUser,
  createConnectorSchema,
  createWebhookSchema,
  type QuotaOverride,
} from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaOverrideDialog } from '../../src/components/admin/quota-override-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ApiError } from '../../src/lib/api-client';
import { AdminBroadcastsPage } from '../../src/routes/admin/broadcasts';
import { AdminConnectorsPage } from '../../src/routes/admin/connectors';
import { AdminReportsPage } from '../../src/routes/admin/reports';
import { AdminRetentionPage } from '../../src/routes/admin/retention';
import { AdminWebhooksPage } from '../../src/routes/admin/webhooks';
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

// Each server or form error is shown under the field it is about, which is
// marked invalid and described by it; every problem at once; and each goes
// when its own field is corrected (#283).

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
  vi.resetAllMocks();
});

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

/** The error shown at a control, as a screen reader reaches it: null when it has none. */
function fieldError(id: string): string | null {
  const control = input(id);
  const invalid = control.getAttribute('aria-invalid') === 'true';
  const described = (control.getAttribute('aria-describedby') ?? '').split(' ');
  const error = document.getElementById(`${id}-error`);
  if (!invalid) {
    expect(error).toBeNull();
    return null;
  }
  expect(described).toContain(`${id}-error`);
  expect(error?.getAttribute('role')).toBe('alert');
  // Under the control, in the same field.
  expect(control.parentElement?.contains(error)).toBe(true);
  return error?.textContent ?? null;
}

const submitIn = (label: string) =>
  click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!,
  );

it('Announcements: Ends before Starts is shown at Ends, and goes when Ends is corrected', async () => {
  api.get.mockResolvedValue({ broadcasts: [] });
  ({ root } = await renderAdmin(<AdminBroadcastsPage />));
  await click(button('New announcement'));
  await typeInto(input('broadcast-title'), 'Fix5 notice');
  await typeIntoTextarea(input('broadcast-body') as unknown as HTMLTextAreaElement, 'Hello.');
  await typeInto(input('broadcast-starts'), '2026-10-22T10:00');
  await typeInto(input('broadcast-ends'), '2026-10-20T10:00');
  await submitIn('Create announcement');
  expect(api.post).not.toHaveBeenCalled();
  expect(fieldError('broadcast-ends')).toBe('Ends: The end time must be after the start time.');
  expect(fieldError('broadcast-starts')).toBeNull();
  // Not repeated at the foot of the dialog.
  expect(alerts(dialog()!)).toEqual(['Ends: The end time must be after the start time.']);
  await typeInto(input('broadcast-ends'), '2026-10-24T10:00');
  expect(fieldError('broadcast-ends')).toBeNull();
});

it('Retention: the time zone error is at its field, which keeps its source note', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/lifecycle/retention')
      return {
        trashRetentionDays: 30,
        threadRetentionDays: null,
        exemptPinnedThreads: true,
        usageEventRetentionDays: 365,
        auditLogRetentionDays: 365,
        memoryRetentionDays: null,
        displayTimezone: 'UTC',
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.put.mockRejectedValueOnce(
    new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
      {
        code: 'custom',
        path: ['displayTimezone'],
        message: 'Use an IANA time zone such as Europe/London or America/New_York.',
      },
    ]),
  );
  ({ root } = await renderAdmin(<AdminRetentionPage />));
  await typeInto(input('display-timezone'), 'Mars/Phobos');
  await click(button('Save retention'));
  expect(fieldError('display-timezone')).toBe(
    'Reporting timezone: Use an IANA time zone such as Europe/London or America/New_York.',
  );
  expect(alerts()).toHaveLength(1);
});

it('Connectors: every problem at once, each at its field; the private-network switch clears the URL’s', async () => {
  api.get.mockResolvedValue({ connectors: [] });
  const body = { name: 'Fix5', url: 'http://mcp.example.test/mcp', slug: 'Bad Short!' };
  // As the API now reports it: the schema's issues with the URL's network rule.
  const refused = validationFailure(createConnectorSchema, body);
  (refused.details as unknown[]).push({
    code: 'custom',
    path: ['url'],
    message: 'Use an https:// address. Plain http:// is allowed only with “Allow private network”.',
  });
  api.post.mockRejectedValueOnce(refused);
  ({ root } = await renderAdmin(<AdminConnectorsPage />, { path: '/admin/connectors' }));
  await click(button('Add connector'));
  await typeInto(input('connector-name'), body.name);
  await typeInto(input('connector-url'), body.url);
  await typeInto(input('connector-slug'), body.slug);
  await submitIn('Add connector');
  expect(fieldError('connector-slug')).toBe(
    'Short name: Use up to 24 lowercase letters, digits and hyphens, such as docs or crm-eu.',
  );
  expect(fieldError('connector-url')).toBe(
    'Server URL: Use an https:// address. Plain http:// is allowed only with “Allow private network”.',
  );
  expect(fieldError('connector-name')).toBeNull();
  await click(input('connector-private'));
  expect(fieldError('connector-url')).toBeNull();
  expect(fieldError('connector-slug')).not.toBeNull();
});

/** The API's refusal of `body`: the schema's issues, then the URL's network rule (#283). */
function refusal(schema: Parameters<typeof validationFailure>[0], body: Record<string, unknown>) {
  const result = schema.safeParse(body);
  const details = result.success ? [] : JSON.parse(JSON.stringify(result.error.issues));
  if (
    typeof body.url === 'string' &&
    body.url.startsWith('http://') &&
    !body.allowPrivateNetwork &&
    !details.some((issue: { path: unknown[] }) => issue.path[0] === 'url')
  )
    details.push({ code: 'custom', path: ['url'], message: HTTPS_ONLY });
  return new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', details);
}

const HTTPS_ONLY =
  'Use an https:// address. Plain http:// is allowed only with “Allow private network”.';

it('Connectors: a missing name and an http:// URL are both reported by one save (#301)', async () => {
  api.get.mockResolvedValue({ connectors: [] });
  api.post.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    throw refusal(createConnectorSchema, body);
  });
  ({ root } = await renderAdmin(<AdminConnectorsPage />, { path: '/admin/connectors' }));
  await click(button('Add connector'));
  await typeInto(input('connector-url'), 'http://mcp.example.test/mcp');
  await submitIn('Add connector');
  expect(api.post).toHaveBeenCalledOnce();
  expect(fieldError('connector-name')).toBe('Name is required.');
  expect(fieldError('connector-url')).toBe(`Server URL: ${HTTPS_ONLY}`);
  await typeInto(input('connector-name'), 'Fix6');
  expect(fieldError('connector-name')).toBeNull();
  expect(fieldError('connector-url')).toBe(`Server URL: ${HTTPS_ONLY}`);
});

it('Webhooks: an http:// URL and an empty action list are both reported by one save (#301)', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/webhooks') return { webhooks: [] };
    if (path === '/admin/audit/actions') return { actions: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    throw refusal(createWebhookSchema, body);
  });
  ({ root } = await renderAdmin(<AdminWebhooksPage />, { path: '/admin/webhooks' }));
  await click(button('Add endpoint'));
  await typeInto(input('webhook-url'), 'http://webhook-echo:8080/walk6');
  await submitIn('Add endpoint');
  expect(api.post).toHaveBeenCalledOnce();
  expect(fieldError('webhook-url')).toBe(`URL: ${HTTPS_ONLY}`);
  expect(fieldError('webhook-actions')).toBe(
    'Audit actions: Choose at least one audit action, or all of them.',
  );
  // An empty URL is the API's to report too, at the URL.
  await typeInto(input('webhook-url'), '');
  await submitIn('Add endpoint');
  expect(fieldError('webhook-url')).toBe(
    'URL: Enter the endpoint’s full URL, such as https://hooks.example.com/oci.',
  );
  expect(fieldError('webhook-actions')).not.toBeNull();
});

it('Webhooks: the URL error names the URL, sits at it, and goes when private network is allowed', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/webhooks') return { webhooks: [] };
    if (path === '/admin/audit/actions') return { actions: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  const body = {
    url: 'http://hooks.example.test/oci',
    description: '',
    allActions: true,
    actions: [],
    enabled: true,
    allowPrivateNetwork: false,
  };
  // The schema accepts it; the API's network rule refuses it, at the URL.
  expect(createWebhookSchema.safeParse(body).success).toBe(true);
  api.post.mockRejectedValueOnce(
    new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
      {
        code: 'custom',
        path: ['url'],
        message:
          'Use an https:// address. Plain http:// is allowed only with “Allow private network”.',
      },
    ]),
  );
  ({ root } = await renderAdmin(<AdminWebhooksPage />, { path: '/admin/webhooks' }));
  await click(button('Add endpoint'));
  await typeInto(input('webhook-url'), body.url);
  await click(input('webhook-all-actions'));
  await submitIn('Add endpoint');
  expect(fieldError('webhook-url')).toBe(
    'URL: Use an https:// address. Plain http:// is allowed only with “Allow private network”.',
  );
  expect(alerts(dialog()!)).toHaveLength(1);
  await click(input('webhook-private'));
  expect(fieldError('webhook-url')).toBeNull();
});

it('Reports: a bad recipient is named at the Recipients field, and goes when corrected', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports') return { reports: [] };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  ({ root } = await renderAdmin(<AdminReportsPage />));
  await typeInto(input('report-name'), 'Fix5 report');
  await typeInto(input('report-recipients'), 'not-an-email, admin@northbrook.edu');
  await click(button('Add report'));
  expect(api.post).not.toHaveBeenCalled();
  expect(fieldError('report-recipients')).toBe('Recipients: not-an-email is not an email address.');
  await typeInto(input('report-recipients'), 'admin@northbrook.edu');
  expect(fieldError('report-recipients')).toBeNull();
});

it('Reports: an API refusal is shown at the field it names', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reports') return { reports: [] };
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockRejectedValueOnce(
    new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
      // A name of spaces only, which the API trims to nothing.
      { code: 'too_small', origin: 'string', minimum: 1, path: ['name'], message: 'Invalid input' },
    ]),
  );
  ({ root } = await renderAdmin(<AdminReportsPage />));
  await typeInto(input('report-name'), '   ');
  await typeInto(input('report-recipients'), 'admin@northbrook.edu');
  await click(button('Add report'));
  expect(fieldError('report-name')).toBe('Name is required.');
  expect(fieldError('report-recipients')).toBeNull();
  await typeInto(input('report-name'), 'Fix5 report');
  expect(fieldError('report-name')).toBeNull();
});

it('Adjust limits: an expiry in the past is shown at Expires, and goes once it is corrected', async () => {
  const entry: QuotaOverride = {
    policyId: 'p1',
    policyName: 'Fix5 monthly messages',
    metric: 'messages',
    roleLimitValue: 100,
    limitValue: 100,
    expiresAt: null,
    reason: null,
    active: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  } as QuotaOverride;
  api.get.mockResolvedValue({ overrides: [entry] });
  api.put.mockRejectedValueOnce(
    new ApiError(422, 'VALIDATION_FAILED', 'The expiry must be in the future.', [
      { path: ['expiresAt'], message: 'Choose a date later than now.' },
    ]),
  );
  ({ root } = await renderAdmin(
    <Dialog open>
      <QuotaOverrideDialog
        user={{ id: 'u1', name: 'Fix5 Person', email: 'fix5@example.edu' } as AdminUser}
        onClose={() => undefined}
      />
    </Dialog>,
  ));
  await typeInto(input('expires-p1'), '2020-01-01');
  await click(button('Save override for Fix5 monthly messages'));
  expect(fieldError('expires-p1')).toBe('Expires: Choose a date later than now.');
  expect(fieldError('limit-p1')).toBeNull();
  // Editing another field leaves it; correcting the date clears it, before any Save.
  await typeInto(input('reason-p1'), 'Exam week');
  expect(fieldError('expires-p1')).not.toBeNull();
  await typeInto(input('expires-p1'), '2030-01-01');
  expect(fieldError('expires-p1')).toBeNull();
  expect(alerts(dialog()!)).toEqual([]);
});
