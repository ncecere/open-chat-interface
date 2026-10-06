// @vitest-environment happy-dom
import type { AdminUser, QuotaOverride } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaOverrideDialog } from '../../src/components/admin/quota-override-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ApiError } from '../../src/lib/api-client';
import {
  alerts,
  button,
  buttonNames,
  cleanup,
  click,
  dialog,
  renderAdmin,
} from './admin-test-utils';

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

function override(overrides: Partial<QuotaOverride>): QuotaOverride {
  return {
    policyId: 'p1',
    policyName: 'Walk monthly messages',
    metric: 'messages',
    roleLimitValue: 1_000_000,
    limitValue: 1_000_000,
    expiresAt: null,
    reason: null,
    active: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

it('names the Expires field as labelled when the API refuses a date (#228)', async () => {
  api.get.mockResolvedValue({ overrides: [override({})] });
  // As setUserOverride refuses a past expiry.
  api.put.mockRejectedValueOnce(
    new ApiError(422, 'VALIDATION_FAILED', 'The expiry must be in the future.', [
      { path: ['expiresAt'], message: 'Choose a date later than now.' },
    ]),
  );
  ({ root } = await renderAdmin(
    <Dialog open>
      <QuotaOverrideDialog
        user={{ id: 'u1', name: 'Walk Person', email: 'walk@example.edu' } as AdminUser}
        onClose={() => undefined}
      />
    </Dialog>,
  ));
  await click(button('Save'));
  expect(alerts(dialog()!).join(' ')).toContain('Expires: Choose a date later than now.');
  expect(alerts(dialog()!).join(' ')).not.toContain('Expires at');
});

it('shows role defaults with thousands separators, as the rest of the admin does (#80)', async () => {
  api.get.mockResolvedValue({
    overrides: [
      override({}),
      override({
        policyId: 'p2',
        policyName: 'Walk spend',
        metric: 'cost',
        roleLimitValue: 2_500_000_000,
        limitValue: 2_500_000_000,
      }),
    ],
  });
  ({ root } = await renderAdmin(
    <Dialog open>
      <QuotaOverrideDialog
        user={{ id: 'u1', name: 'Walk Person', email: 'walk@example.edu' } as AdminUser}
        onClose={() => undefined}
      />
    </Dialog>,
  ));
  const text = dialog()?.textContent ?? '';
  expect(text).toContain('Role default: 1,000,000 messages');
  expect(text).toContain('Role default: 2,500.00 US dollars');
  // The inputs still hold plain numbers, which is what they parse.
  const inputs = [...(dialog()?.querySelectorAll<HTMLInputElement>('input') ?? [])].map(
    (input) => input.value,
  );
  expect(inputs).toContain('1000000');
  // Each budget's Save names the budget, and its fields sit in a group named for it (#260).
  expect(buttonNames(dialog()!)).toEqual(
    expect.arrayContaining([
      'Save override for Walk monthly messages',
      'Save override for Walk spend',
    ]),
  );
  expect(
    [...dialog()!.querySelectorAll('fieldset[aria-labelledby]')].map(
      (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
    ),
  ).toEqual(['Walk monthly messages', 'Walk spend']);
});
