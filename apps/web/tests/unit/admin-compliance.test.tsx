// @vitest-environment happy-dom
import type { ComplianceStatus, LegalHold } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../src/lib/utils';
import { AdminCompliancePage, complianceChanges } from '../../src/routes/admin/compliance';
import { AdminUserDetailPage } from '../../src/routes/admin/user-detail';
import { AdminUsersPage } from '../../src/routes/admin/users';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => ({ userId: 'user-1' }),
}));

const activeHold: LegalHold = {
  id: 'h1',
  userId: 'user-1',
  userEmail: 'dana@example.test',
  userName: 'Dana Held',
  reason: 'Matter 2026-17',
  placedAt: '2026-10-01T09:00:00.000Z',
  placedByEmail: 'admin@example.test',
  liftedAt: null,
  liftedByEmail: null,
  liftReason: null,
};

function status(overrides: Partial<ComplianceStatus> = {}): ComplianceStatus {
  return {
    settings: {
      enabled: true,
      schedule: 'daily',
      hourUtc: 2,
      destination: 'separate',
      prefix: 'oci-compliance/',
      s3: {
        bucket: 'records',
        region: 'us-east-1',
        endpoint: null,
        accessKeyId: 'AKIA',
        forcePathStyle: false,
        hasCredential: true,
      },
      includeContent: false,
      keepDays: null,
    },
    issues: [],
    attachmentStorage: { driver: 's3', bucket: 'oci-attachments' },
    running: false,
    nextRunAt: '2026-10-03T02:00:00.000Z',
    lastSuccessAt: '2026-10-02T02:01:00.000Z',
    cursor: { audit: 412, messages: null },
    runs: [
      {
        id: 'r2',
        trigger: 'schedule',
        status: 'failed',
        startedAt: '2026-10-02T09:00:00.000Z',
        finishedAt: '2026-10-02T09:00:01.000Z',
        destination: 'separate',
        includeContent: false,
        audit: {
          key: null,
          afterSeq: 400,
          throughSeq: 412,
          count: null,
          bytes: null,
          sha256: null,
        },
        messages: null,
        manifestKey: null,
        verified: false,
        errorMessage: 'Export failed: Access Denied',
        prunedAt: null,
      },
      {
        id: 'r1',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: '2026-10-02T02:00:00.000Z',
        finishedAt: '2026-10-02T02:01:00.000Z',
        destination: 'separate',
        includeContent: false,
        audit: {
          key: 'oci-compliance/2026/10/02/x/audit.jsonl',
          afterSeq: 0,
          throughSeq: 400,
          count: 400,
          bytes: 2048,
          sha256: 'abc',
        },
        messages: null,
        manifestKey: 'oci-compliance/2026/10/02/x/manifest.json',
        verified: true,
        errorMessage: null,
        prunedAt: null,
      },
    ],
    holds: [
      activeHold,
      {
        ...activeHold,
        id: 'h0',
        userId: 'user-2',
        userEmail: 'old@example.test',
        userName: null,
        reason: 'Closed matter',
        liftedAt: '2026-09-01T00:00:00.000Z',
        liftedByEmail: 'admin@example.test',
        liftReason: 'Settled',
      },
    ],
    ...overrides,
  };
}

let root: Root | undefined;
let current: ComplianceStatus;
beforeEach(() => {
  current = status();
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/compliance') return current;
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockResolvedValue({ started: true });
  api.patch.mockImplementation(async () => current);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<AdminCompliancePage />, { role, path: '/admin/compliance' }));
};

describe('Compliance admin page', () => {
  it('shows the schedule, the last export, the cursor, holds and the run history', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Daily at 02:00 UTC');
    expect(text).toContain('Audit events only');
    expect(text).toContain('Audit events exported through #412');
    expect(text).toContain('The latest export failed');
    expect(text).toContain('Export failed: Access Denied');
    expect(text).toContain('400 audit events');
    expect(document.querySelectorAll('[data-testid="compliance-run"]')).toHaveLength(2);
    // Active holds are listed; lifted ones are kept as history.
    const holds = document.querySelectorAll('[data-testid="legal-hold"]');
    expect(holds).toHaveLength(1);
    // The admin date format, not the browser default with seconds (#177).
    expect(holds[0]?.textContent).toContain(`Placed ${formatDateTime(activeHold.placedAt)}`);
    expect(holds[0]?.textContent).not.toContain(new Date(activeHold.placedAt).toLocaleString());
    expect(holds[0]!.textContent).toContain('Dana Held');
    expect(holds[0]!.textContent).toContain('Matter 2026-17');
    expect(text).toContain('1 lifted hold');
    expect(text).toContain('Set. Leave empty to keep it');
    // Content export is off, so its warning is not shown.
    expect(text).not.toContain('Conversation content leaves OCI');
  });

  it('exports now, and explains why it cannot', async () => {
    await render();
    await click(button('Export now'));
    expect(api.post).toHaveBeenCalledWith('/admin/compliance/run');
    await cleanup(root!);
    current = status({ issues: ['S3 bucket is required.'] });
    await render();
    expect(document.body.textContent).toContain('The export cannot run yet');
    expect(button('Export now').disabled).toBe(true);
  });

  it('warns clearly before conversation content is exported, and saves only what changed', async () => {
    await render();
    await click(document.getElementById('compliance-content') as HTMLElement);
    expect(document.body.textContent).toContain('Conversation content leaves OCI');
    expect(document.body.textContent).toContain('earlier conversations are not');
    await typeInto(document.getElementById('compliance-keep-days') as HTMLInputElement, '365');
    await typeInto(document.getElementById('compliance-secret') as HTMLInputElement, 'new-secret');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/compliance/settings', {
      includeContent: true,
      keepDays: 365,
      s3: { secretAccessKey: 'new-secret' },
    });
  });

  it('places a hold with a reason and lifts one after confirming', async () => {
    api.post.mockResolvedValue({ hold: activeHold });
    await render();
    await typeInto(document.getElementById('hold-email') as HTMLInputElement, 'sam@example.test');
    expect(button('Place hold').disabled).toBe(true);
    await typeInto(document.getElementById('hold-reason') as HTMLInputElement, 'Matter 9');
    await click(button('Place hold'));
    expect(api.post).toHaveBeenCalledWith('/admin/compliance/holds', {
      email: 'sam@example.test',
      reason: 'Matter 9',
    });

    await click(button('Lift'));
    expect(dialog()?.textContent).toContain('Lift the hold on Dana Held?');
    await typeInto(document.getElementById('lift-reason') as HTMLInputElement, 'Settled');
    await click(button('Lift hold'));
    expect(api.post).toHaveBeenCalledWith('/admin/compliance/holds/h1/lift', {
      reason: 'Settled',
    });
  });

  it('is read-only for auditors', async () => {
    await render('auditor');
    for (const name of ['Export now', 'Test destination', 'Save changes', 'Place hold', 'Lift'])
      expect(findButton(name), name).toBeUndefined();
    expect(document.getElementById('hold-email')).toBeNull();
    const bucket = document.getElementById('compliance-bucket') as HTMLInputElement;
    expect(bucket.closest('fieldset')?.disabled).toBe(true);
    // Still readable.
    expect(document.body.textContent).toContain('Matter 2026-17');
  });

  it('computes an empty patch for an unchanged form, and null for a cleared retention', () => {
    const saved = status({ settings: { ...status().settings, keepDays: 30 } });
    const draft = {
      enabled: true,
      schedule: 'daily' as const,
      hourUtc: 2,
      destination: 'separate' as const,
      prefix: 'oci-compliance/',
      bucket: 'records',
      region: 'us-east-1',
      endpoint: '',
      accessKeyId: 'AKIA',
      forcePathStyle: false,
      secretAccessKey: '',
      includeContent: false,
      keepDays: '30',
    };
    expect(complianceChanges(saved, draft)).toEqual({});
    expect(
      complianceChanges(saved, { ...draft, keepDays: ' ', schedule: 'hourly', enabled: false }),
    ).toEqual({ enabled: false, schedule: 'hourly', keepDays: null });
  });
});

describe('legal hold marking', () => {
  const held = {
    id: 'user-1',
    name: 'Dana Held',
    email: 'dana@example.test',
    image: null,
    role: 'user',
    emailVerified: true,
    banned: false,
    banReason: null,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    threadCount: 2,
    messageCount: 4,
    legalHold: true,
  };

  it('marks held people in the users list', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/users?'))
        return {
          users: [held, { ...held, id: 'user-2', email: 'free@example.test', legalHold: false }],
          total: 2,
        };
      if (path.startsWith('/admin/views')) return { views: [] };
      throw new Error(`Unexpected GET ${path}`);
    });
    ({ root } = await renderAdmin(<AdminUsersPage />, { path: '/admin/users' }));
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Legal hold');
    expect(rows[1]!.textContent).not.toContain('Legal hold');
  });

  it('shows the hold and its reason on the account page', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/users/user-1')
        return {
          user: held,
          legalHold: {
            reason: 'Matter 2026-17',
            placedAt: '2026-10-01T09:00:00.000Z',
            placedByEmail: 'admin@example.test',
          },
          storage: { bytesUsed: 0, fileCount: 0 },
          sessions: [],
          recentThreads: [],
          audit: [],
        };
      if (path === '/admin/users/user-1/limits')
        return {
          usage: { allowances: [], recent: { messages: 0, tokens: 0, costMicros: 0 } },
          storage: {
            liveBytes: 0,
            liveFileCount: 0,
            pendingBytes: 0,
            pendingFileCount: 0,
            maxTotalBytes: null,
            maxFileCount: null,
            maxFileBytes: null,
          },
        };
      if (path === '/admin/users/user-1/quota-overrides') return { overrides: [] };
      throw new Error(`Unexpected GET ${path}`);
    });
    ({ root } = await renderAdmin(<AdminUserDetailPage />, {
      path: '/admin/users/user-1',
      role: 'auditor',
    }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('This person is on legal hold');
    expect(text).toContain('Reason: Matter 2026-17');
    expect(text).toContain('by admin@example.test');
  });
});
