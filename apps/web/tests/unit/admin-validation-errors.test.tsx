// @vitest-environment happy-dom
import { updateRetentionSettingsSchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaPolicyDialog } from '../../src/components/admin/quota-policy-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { AdminRetentionPage } from '../../src/routes/admin/retention';
import {
  button,
  cleanup,
  click,
  dialog,
  renderAdmin,
  typeInto,
  validationFailure,
} from './admin-test-utils';

// Forms that keep their error as text, rather than in MutationError, still
// name the field and the rule instead of "Request validation failed" (#127).

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

const retention = {
  trashRetentionDays: 30,
  threadRetentionDays: null,
  exemptPinnedThreads: true,
  usageEventRetentionDays: 365,
  auditLogRetentionDays: 365,
  memoryRetentionDays: null,
  displayTimezone: 'UTC',
};

async function saveRetention(field: string, value: string, body: Record<string, unknown>) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/lifecycle/retention') return retention;
    throw new Error(`Unexpected GET ${path}`);
  });
  api.put.mockRejectedValueOnce(validationFailure(updateRetentionSettingsSchema, body));
  ({ root } = await renderAdmin(<AdminRetentionPage />));
  await typeInto(document.getElementById(field) as HTMLInputElement, value);
  await click(button('Save retention'));
  return document.querySelector('[role="alert"]')?.textContent;
}

it('Retention: the Keep pinned conversations switch is described by what it does (#310)', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/lifecycle/retention') return retention;
    throw new Error(`Unexpected GET ${path}`);
  });
  ({ root } = await renderAdmin(<AdminRetentionPage />));
  const ids = document.getElementById('exempt-pinned')?.getAttribute('aria-describedby') ?? '';
  const described = ids
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ');
  expect(described).toContain('Pinned conversations are never removed automatically.');
});

it('Retention names the time zone field and the rule', async () => {
  expect(
    await saveRetention('display-timezone', 'Mars/Olympus', { displayTimezone: 'Mars/Olympus' }),
  ).toBe('Reporting timezone: Use an IANA time zone such as Europe/London or America/New_York.');
});

it('Retention clears the error once the field is corrected, with Save disabled (#217)', async () => {
  await saveRetention('display-timezone', 'Mars/Olympus', { displayTimezone: 'Mars/Olympus' });
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await typeInto(document.getElementById('display-timezone') as HTMLInputElement, 'UTC');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(button('Save retention').disabled).toBe(true);
});

it('Retention keeps the error about a field still wrong when another is corrected (#257)', async () => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/lifecycle/retention') return retention;
    throw new Error(`Unexpected GET ${path}`);
  });
  api.put.mockRejectedValueOnce(
    validationFailure(updateRetentionSettingsSchema, {
      usageEventRetentionDays: 5000,
      displayTimezone: 'Mars/Olympus',
    }),
  );
  ({ root } = await renderAdmin(<AdminRetentionPage />));
  const zone = document.getElementById('display-timezone') as HTMLInputElement;
  await typeInto(document.getElementById('usage-days') as HTMLInputElement, '5000');
  await typeInto(zone, 'Mars/Olympus');
  await click(button('Save retention'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Usage history');
  await typeInto(zone, 'UTC');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Usage history (days) must be at most 3,650.',
  );
});

it('Retention names a number field and its bound', async () => {
  expect(await saveRetention('usage-days', '5000', { usageEventRetentionDays: 5000 })).toBe(
    'Usage history (days) must be at most 3,650.',
  );
});

async function openPolicyDialog() {
  api.get.mockResolvedValue({ models: [] });
  ({ root } = await renderAdmin(
    <Dialog open>
      <QuotaPolicyDialog policy={null} onClose={() => undefined} />
    </Dialog>,
  ));
  await typeInto(document.getElementById('policy-limit') as HTMLInputElement, '100');
}

const createPolicy = () =>
  click(
    [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create budget',
    )!,
  );

it("the usage budget dialog's own check names the field and the rule", async () => {
  await openPolicyDialog();
  await typeInto(document.getElementById('policy-name') as HTMLInputElement, 'W'.repeat(81));
  await createPolicy();
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    'Name must be at most 80 characters.',
  );
});

it('the usage budget dialog caps a rolling window at the API limit', async () => {
  await openPolicyDialog();
  await typeInto(document.getElementById('policy-name') as HTMLInputElement, 'Walk3 budget');
  await click(document.getElementById('policy-window') as HTMLElement);
  const rolling = [...document.querySelectorAll('[role="option"]')].find((option) =>
    option.textContent?.includes('Rolling window'),
  ) as HTMLElement;
  await click(rolling);
  const length = document.getElementById('policy-window-hours') as HTMLInputElement;
  await typeInto(length, '100000');
  // Refused before anything is sent, at the field, saying what the maximum is (#320).
  await createPolicy();
  expect(api.post).not.toHaveBeenCalled();
  expect(document.getElementById('policy-window-hours-error')?.textContent).toBe(
    'Window length (hours) must be at most 8,760.',
  );
});
