// @vitest-environment happy-dom
import type { MaintenanceSettings } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaintenanceMode, toLocalInput } from '../../src/components/admin/maintenance-mode';
import { setReadOnlyStatus } from '../../src/lib/read-only';
import { alerts, button, cleanup, click, renderAdmin, typeInto } from './admin-test-utils';

/** The read-only switch on System health → Maintenance (#222). */
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const OFF = { active: false, source: null, reason: null, until: null, window: null } as const;

const view = (overrides: Partial<MaintenanceSettings> = {}): MaintenanceSettings => ({
  status: OFF,
  environmentLocked: false,
  readOnly: false,
  reason: null,
  until: null,
  changedAt: null,
  changedBy: null,
  window: null,
  jobs: [],
  ...overrides,
});

let healthFetches = 0;
/** Stands in for the Health checks section, which shares the page. */
function HealthProbe() {
  useQuery({
    queryKey: ['admin', 'health'],
    queryFn: async () => {
      healthFetches += 1;
      return {};
    },
  });
  return null;
}

let root: Root | undefined;
beforeEach(() => {
  healthFetches = 0;
  setReadOnlyStatus(OFF);
  api.get.mockReset();
  api.put.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const reasonInput = () => document.querySelector<HTMLInputElement>('input[id$="-reason"]')!;
const untilInput = () => document.querySelector<HTMLInputElement>('input[id$="-until"]')!;

it('starts with an empty reason, not the one from the last time', async () => {
  // A server older than this fix still sends the last reason while off.
  api.get.mockResolvedValue(view({ reason: 'Walk2 resilience read-only test' }));
  ({ root } = await renderAdmin(<MaintenanceMode />));
  expect(reasonInput().value).toBe('');
  expect(untilInput().value).toBe('');
});

it('refuses an expected end in the past before asking to confirm', async () => {
  api.get.mockResolvedValue(view());
  ({ root } = await renderAdmin(<MaintenanceMode />));
  await typeInto(untilInput(), toLocalInput(new Date(Date.now() - 86_400_000).toISOString()));
  await click(button('Turn on read-only mode'));
  expect(alerts()).toContain('Expected end: Choose a time later than now.');
  expect(button('Turn on read-only mode')).toBeTruthy();
  expect(api.put).not.toHaveBeenCalled();
  // Corrected, the complaint goes and the switch can be confirmed.
  await typeInto(untilInput(), toLocalInput(new Date(Date.now() + 86_400_000).toISOString()));
  expect(alerts()).toEqual([]);
});

it('refreshes the Health checks row with the switch, and empties the form again', async () => {
  const on = view({
    readOnly: true,
    reason: 'Walk3 QA check',
    status: { ...OFF, active: true, source: 'administrator', reason: 'Walk3 QA check' },
  });
  api.get.mockResolvedValue(view());
  api.put.mockResolvedValueOnce(on).mockResolvedValueOnce(view());
  ({ root } = await renderAdmin(
    <>
      <HealthProbe />
      <MaintenanceMode />
    </>,
  ));
  const before = healthFetches;
  await typeInto(reasonInput(), 'Walk3 QA check');
  await click(button('Turn on read-only mode'));
  await click(button('Confirm: refuse every change now'));
  expect(healthFetches).toBe(before + 1);

  await click(button('Turn off read-only mode'));
  expect(healthFetches).toBe(before + 2);
  expect(reasonInput().value).toBe('');
});
