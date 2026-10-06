// @vitest-environment happy-dom
import { type InstanceSettings, updateInstanceSettingsSchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { BrandingForm } from '../../src/routes/admin/branding/branding-form';
import { AdminCompliancePage } from '../../src/routes/admin/compliance';
import { SearchSettingsForm } from '../../src/routes/admin/search/search-settings-form';
import { StorageSettingsForm } from '../../src/routes/admin/storage/storage-settings-form';
import {
  alerts,
  button,
  cleanup,
  click,
  renderAdmin,
  typeInto,
  validationFailure,
} from './admin-test-utils';

// The sweep after #317: a refusal from the API is shown at the field it
// names, marked invalid and described by it, and goes once that field is
// edited, on every settings form, not beside Save.

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

/** The error shown at a control: null when it has none. */
function fieldError(id: string): string | null {
  const control = input(id);
  const error = document.getElementById(`${id}-error`);
  if (control.getAttribute('aria-invalid') !== 'true') return null;
  expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(`${id}-error`);
  expect(error?.getAttribute('role')).toBe('alert');
  return error?.textContent ?? null;
}

/** The API refusing `body` as its real schema does, whatever the form sent. */
const refuse = (method: typeof api.patch, body: unknown) =>
  method.mockRejectedValue(validationFailure(updateInstanceSettingsSchema, body));

it('Web search: a refused maximum is at its field', async () => {
  refuse(api.patch, { search: { maxResults: 0 } });
  const settings = {
    features: { webSearch: false },
    search: {
      enabled: false,
      provider: 'searxng',
      baseUrl: 'http://search.test',
      hasCredential: false,
      maxResults: 5,
    },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<SearchSettingsForm settings={settings} />));
  await typeInto(input('search-max-results'), '8');
  await click(button('Save changes'));
  expect(fieldError('search-max-results')).toBe('Maximum results must be more than 0.');
  expect(alerts()).toEqual(['Maximum results must be more than 0.']);
  await typeInto(input('search-max-results'), '9');
  expect(fieldError('search-max-results')).toBeNull();
});

it('Storage: a refused file count is at its field', async () => {
  refuse(api.patch, { storage: { maxFilesPerMessage: 0 } });
  ({ root } = await renderAdmin(
    <StorageSettingsForm
      initialSettings={{
        driver: 'local',
        localPath: '/data/attachments',
        maxFileBytes: 10_485_760,
        maxFilesPerMessage: 5,
        allowedMimeTypes: ['image/png'],
        s3: {
          bucket: '',
          region: '',
          endpoint: null,
          accessKeyId: '',
          forcePathStyle: false,
          hasCredential: false,
        },
      }}
    />,
    { path: '/admin/storage?tab=uploads' },
  ));
  await typeInto(input('max-files-per-message'), '6');
  await click(button('Save changes'));
  expect(fieldError('max-files-per-message')).toBe(
    'Maximum files per message must be more than 0.',
  );
  expect(alerts()).toEqual(['Maximum files per message must be more than 0.']);
});

it('Branding: a refused logo address is at its field', async () => {
  refuse(api.patch, { logoUrl: 'javascript:alert(1)' });
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <BrandingForm
        initialSettings={{
          appName: 'Northbrook AI',
          shortName: null,
          logoUrl: null,
          colorTheme: 'neutral',
          loginMessage: null,
          defaultTheme: 'system',
        }}
      />
    </ThemeProvider>,
  ));
  await typeInto(input('logo-url'), '/logo.png');
  await click(button('Save changes'));
  expect(fieldError('logo-url')).toBe(
    'Logo URL: Use an http(s) URL or a root-relative path beginning with /.',
  );
  expect(alerts()).toHaveLength(1);
});

it('Compliance › Legal hold: "No account has that address" is at the email field', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/compliance')
      return {
        settings: {
          enabled: false,
          schedule: 'daily',
          hourUtc: 2,
          destination: 'storage',
          prefix: 'oci-compliance/',
          s3: {
            bucket: '',
            region: '',
            endpoint: null,
            accessKeyId: '',
            forcePathStyle: false,
            hasCredential: false,
          },
          includeContent: false,
          keepDays: null,
        },
        issues: [],
        attachmentStorage: { driver: 's3', bucket: 'oci-attachments' },
        running: false,
        nextRunAt: null,
        lastSuccessAt: null,
        cursor: { audit: 0, messages: null },
        runs: [],
        holds: [],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'No account has that address.'));
  ({ root } = await renderAdmin(<AdminCompliancePage />, { path: '/admin/compliance' }));
  await typeInto(input('hold-email'), 'nobody@example.edu');
  await typeInto(input('hold-reason'), 'Matter 9');
  await click(button('Place hold'));
  expect(fieldError('hold-email')).toBe('No account has that address.');
  await typeInto(input('hold-email'), 'sam@example.edu');
  expect(fieldError('hold-email')).toBeNull();
});
