// @vitest-environment happy-dom
import type { InstanceSettings, MaintenanceSettings } from '@oci/shared';
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderCapacitySection } from '../../src/components/admin/capacity-limits';
import { MaintenanceMode } from '../../src/components/admin/maintenance-mode';
import { UnsavedChangesGuard } from '../../src/components/admin/unsaved-changes';
import { BackgroundWorkSection } from '../../src/components/admin/upgrades';
import { AdminConnectorsPage } from '../../src/routes/admin/connectors';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { AdminReportsPage } from '../../src/routes/admin/reports';
import { GeneralSettings } from '../../src/routes/admin/settings/general-settings';
import { AdminWebhooksPage } from '../../src/routes/admin/webhooks';
import { button, cleanup, click, dialog, renderAdmin, settle, typeInto } from './admin-test-utils';

// Every editable admin form asks before its edit is left behind (#45), not
// only some of them (#300): General's six sections, Providers › Capacity,
// Maintenance, Background work, Reports, and the dialogs' Escape.

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
let confirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>;
beforeEach(() => {
  confirm = vi.fn<(message?: string) => boolean>(() => false);
  Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true });
  for (const method of Object.values(api)) method.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const byId = <T extends HTMLElement = HTMLInputElement>(id: string) =>
  document.getElementById(id) as T;

/** Renders `ui` in the admin layout's guard, makes `edit`, then tries to leave. */
async function leaveAfter(ui: ReactNode, edit: () => Promise<void>) {
  let router!: Awaited<ReturnType<typeof renderAdmin>>['router'];
  ({ root, router } = await renderAdmin(<UnsavedChangesGuard>{ui}</UnsavedChangesGuard>, {
    path: '/admin/page',
  }));
  expect(confirm).not.toHaveBeenCalled();
  await edit();
  // A blocked navigation never settles, so it is not awaited.
  await act(async () => {
    void router.navigate({ to: '/admin/retention' as never });
  });
  await settle();
  return router;
}

async function expectAsked(ui: ReactNode, edit: () => Promise<void>) {
  const router = await leaveAfter(ui, edit);
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/admin/page');
}

const settings = {
  defaultSystemPrompt: null,
  defaultEffort: 'instant',
  maxToolSteps: 8,
  autoCompact: true,
  diagramGuidance: true,
  storage: { driver: 'local' },
  features: {
    shareLinks: false,
    temporaryChat: true,
    branching: true,
    attachments: true,
    memory: false,
  },
} as unknown as InstanceSettings;

it.each([
  ['Tool step limit', async () => typeInto(byId('max-tool-steps'), '12')],
  ['Summarise long conversations', async () => click(byId('auto-compact'))],
  ['Editorial diagrams', async () => click(byId('diagram-guidance'))],
])('General › %s asks before leaving', async (_name, edit) => {
  await expectAsked(<GeneralSettings settings={settings} />, edit);
});

it('General › Default reasoning level asks before leaving', async () => {
  await expectAsked(<GeneralSettings settings={settings} />, async () => {
    const select = byId<HTMLSelectElement>('default-effort');
    await act(async () => {
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  });
});

it('Providers › Capacity asks before leaving', async () => {
  api.get.mockResolvedValue({
    queue: {
      maxWaitSeconds: 120,
      rolePriority: { admin: 'normal', auditor: 'normal', user: 'normal', restricted: 'normal' },
    },
    enforcement: 'shared',
    providers: [],
  });
  await expectAsked(<ProviderCapacitySection />, () => typeInto(byId('capacity-max-wait'), '300'));
});

const maintenance = (overrides: Partial<MaintenanceSettings> = {}): MaintenanceSettings => ({
  status: { active: false, source: null, reason: null, until: null, window: null },
  environmentLocked: false,
  readOnly: false,
  reason: null,
  until: null,
  changedAt: null,
  changedBy: null,
  window: null,
  jobs: [
    { name: 'retention', keepsRunning: false, defaultKeepsRunning: false },
    { name: 'webhooks', keepsRunning: true, defaultKeepsRunning: true },
  ],
  ...overrides,
});

it('Maintenance › Background jobs while read-only asks before leaving', async () => {
  api.get.mockResolvedValue(maintenance());
  await expectAsked(<MaintenanceMode />, async () => {
    const job = [...document.querySelectorAll<HTMLLabelElement>('label')]
      .find((label) => label.textContent?.startsWith('retention'))!
      .querySelector('input')!;
    await click(job);
  });
});

it('Maintenance › the read-only reason and the scheduled window ask before leaving', async () => {
  api.get.mockResolvedValue(maintenance());
  await expectAsked(<MaintenanceMode />, () =>
    typeInto(document.querySelector<HTMLInputElement>('input[id$="-reason"]')!, 'Upgrading'),
  );
  await cleanup(root!);
  confirm.mockClear();
  await expectAsked(<MaintenanceMode />, () =>
    typeInto(document.querySelector<HTMLInputElement>('input[id$="-window-reason"]')!, 'Move'),
  );
});

it('Maintenance › a saved window is not taken for an unsaved edit', async () => {
  api.get.mockResolvedValue(
    maintenance({
      window: {
        startsAt: '2026-11-01T02:00:00.000Z',
        endsAt: '2026-11-01T04:00:00.000Z',
        reason: 'Database move',
      },
    }),
  );
  const router = await leaveAfter(<MaintenanceMode />, async () => {});
  expect(confirm).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe('/admin/retention');
});

it('System health › Background work’s pace asks before leaving', async () => {
  api.get.mockResolvedValue({
    migrations: [
      {
        name: '0.11.backfill',
        description: 'Fills the new column.',
        release: '0.11.0',
        table: 'public.message',
        bundled: true,
        status: 'running',
        cursor: null,
        batchSize: 1_000,
        pauseMs: 50,
        rowsProcessed: 0,
        batches: 0,
        estimatedRows: null,
        tableBytes: null,
        progress: 0,
        attempts: 0,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        nextRunAt: null,
        throttledReason: null,
        throttledAt: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  });
  await expectAsked(<BackgroundWorkSection />, () =>
    typeInto(byId('migration-0-11-backfill-batch'), '250'),
  );
});

it('Reports › a report half added asks before leaving', async () => {
  api.get.mockImplementation(async (path: string) =>
    path === '/admin/reports' ? { reports: [] } : { checks: [] },
  );
  await expectAsked(<AdminReportsPage />, () => typeInto(byId('report-name'), 'Fix6 report'));
});

/** Like a real key press, the event can be cancelled. */
async function pressCancelableEscape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

it.each([
  [
    'Webhooks › Add endpoint',
    <AdminWebhooksPage key="webhooks" />,
    'Add endpoint',
    async () => typeInto(byId('webhook-url'), 'https://hooks.example.test/oci'),
  ],
  [
    'Connectors › Add connector',
    <AdminConnectorsPage key="connectors" />,
    'Add connector',
    async () => typeInto(byId('connector-name'), 'Fix6 connector'),
  ],
  [
    'Invitations › Create invitation',
    <AdminInvitesPage key="invites" />,
    'Create invitation',
    async () => typeInto(byId('invite-email'), 'fix6@example.test'),
  ],
])('%s asks before Escape discards an edit', async (_name, page, opener, edit) => {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/webhooks') return { webhooks: [] };
    if (path === '/admin/connectors') return { connectors: [] };
    if (path.startsWith('/admin/invites')) return { invites: [] };
    return { actions: [], checks: [] };
  });
  ({ root } = await renderAdmin(page, { path: '/admin/page' }));
  await click(button(opener));
  await edit();
  await pressCancelableEscape();
  expect(confirm).toHaveBeenCalledOnce();
  expect(dialog()).not.toBeNull();
});
