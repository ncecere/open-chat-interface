// @vitest-environment happy-dom
import type { AdminUser, QuotaOverride } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaOverrideDialog } from '../../src/components/admin/quota-override-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { cleanup, dialog, renderAdmin } from './admin-test-utils';

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
});
