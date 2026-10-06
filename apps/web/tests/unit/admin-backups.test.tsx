// @vitest-environment happy-dom
import { type BackupStatus, updateBackupSettingsSchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminBackupsPage, backupChanges } from '../../src/routes/admin/backups';
import {
  alerts,
  button,
  cleanup,
  click,
  findButton,
  renderAdmin,
  typeInto,
  validationFailure,
} from './admin-test-utils';
import { styleFor } from './css-test-utils';
import { untitledTruncations } from './truncation';

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

function status(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    settings: {
      enabled: true,
      hourUtc: 3,
      destination: 'separate',
      prefix: 'oci-backups/',
      s3: {
        bucket: 'oci-backups',
        region: 'us-east-1',
        endpoint: null,
        accessKeyId: 'AKIA',
        forcePathStyle: false,
        hasCredential: true,
      },
      keepDaily: 7,
      keepWeekly: 4,
      copyFiles: true,
      verifyFiles: 'sample',
    },
    issues: [],
    pgDumpVersion: 'pg_dump (PostgreSQL) 17.6',
    attachmentStorage: { driver: 's3', bucket: 'oci-attachments' },
    running: false,
    nextRunAt: '2026-10-03T03:00:00.000Z',
    lastSuccessAt: '2026-10-02T03:04:00.000Z',
    runs: [
      {
        id: 'r2',
        trigger: 'schedule',
        status: 'failed',
        startedAt: '2026-10-02T09:00:00.000Z',
        finishedAt: '2026-10-02T09:00:05.000Z',
        destination: 'separate',
        dumpKey: null,
        dumpBytes: null,
        dumpSha256: null,
        manifestKey: null,
        attachmentCount: null,
        attachmentBytes: null,
        missingObjects: null,
        files: null,
        verified: false,
        verificationDetail: null,
        errorMessage: 'pg_dump failed (exit 1): connection refused',
        prunedAt: null,
      },
      {
        id: 'r1',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: '2026-10-02T03:00:00.000Z',
        finishedAt: '2026-10-02T03:04:00.000Z',
        destination: 'separate',
        dumpKey: 'oci-backups/2026-10-02T03-00-00-000Z-r1/database.dump',
        dumpBytes: 5 * 1024 * 1024,
        dumpSha256: 'abc',
        manifestKey: 'oci-backups/x/manifest.json',
        attachmentCount: 12,
        attachmentBytes: 2048,
        missingObjects: 1,
        files: {
          copiedObjects: 3,
          copiedBytes: 3 * 1024 * 1024,
          skippedObjects: 9,
          skippedBytes: 1024,
          verifiedObjects: 12,
          sweptObjects: 2,
        },
        verified: true,
        verificationDetail: '312 archive entries, 40 tables',
        errorMessage: null,
        prunedAt: null,
      },
    ],
    ...overrides,
  };
}

let root: Root | undefined;
let current: BackupStatus;
beforeEach(() => {
  current = status();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/backups') return current;
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ started: true });
  api.patch.mockReset().mockImplementation(async () => current);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<AdminBackupsPage />, { role, path: '/admin/backups' }));
};

describe('Backups admin page', () => {
  it('shows the schedule, the last good backup, the tools and the run history', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Daily at 03:00 UTC');
    expect(text).toContain('pg_dump (PostgreSQL) 17.6');
    expect(text).toContain('The latest backup failed');
    expect(text).toContain('pg_dump failed (exit 1): connection refused');
    expect(text).toContain('312 archive entries, 40 tables');
    expect(text).toContain('Verified');
    expect(text).toContain('1 missing objects');
    expect(document.querySelectorAll('[data-testid="backup-run"]')).toHaveLength(2);
    // What the run copied, and that copying is on (no warning about it).
    expect(document.querySelector('[data-testid="backup-run-files"]')?.textContent).toBe(
      '3 files copied (3.0 MB) · 9 already backed up (1 KB) · 12 read back · 2 unused copies deleted',
    );
    expect(text).not.toContain('Attachment files are not copied');
    // The secret is never shown, only whether it is set.
    expect(text).toContain('Set. Leave empty to keep it');
  });

  it('starts a backup now, and explains why it cannot run', async () => {
    await render();
    await click(button('Back up now'));
    expect(api.post).toHaveBeenCalledWith('/admin/backups/run');
    await cleanup(root!);
    current = status({ issues: ['S3 bucket is required.'], pgDumpVersion: null });
    await render();
    expect(document.body.textContent).toContain('Backups cannot run yet');
    expect(document.body.textContent).toContain('S3 bucket is required.');
    expect(button('Back up now').disabled).toBe(true);
  });

  it('saves only what changed, with a new secret only when typed', async () => {
    await render();
    await typeInto(document.getElementById('backups-bucket') as HTMLInputElement, 'other-bucket');
    await typeInto(document.getElementById('backups-keep-daily') as HTMLInputElement, '14');
    await typeInto(document.getElementById('backups-secret') as HTMLInputElement, 'new-secret');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/backups/settings', {
      keepDaily: 14,
      s3: { bucket: 'other-bucket', secretAccessKey: 'new-secret' },
    });
  });

  it('names the field and the rule when the API refuses a value (#127)', async () => {
    await render();
    api.patch.mockRejectedValueOnce(
      validationFailure(updateBackupSettingsSchema, { keepDaily: 0 }),
    );
    await typeInto(document.getElementById('backups-keep-daily') as HTMLInputElement, '0');
    await click(button('Save changes'));
    expect(alerts()).toContain('Daily backups kept must be at least 1.');
    // Corrected back to the saved value, Save is disabled: the error used to
    // stay indefinitely (#217).
    await typeInto(document.getElementById('backups-keep-daily') as HTMLInputElement, '7');
    expect(alerts()).not.toContain('Daily backups kept must be at least 1.');
    expect(button('Save changes').disabled).toBe(true);
  });

  it('keeps the error about a field still wrong while another is corrected (#257)', async () => {
    await render();
    api.patch.mockRejectedValueOnce(
      validationFailure(updateBackupSettingsSchema, { keepDaily: 0, keepWeekly: 200 }),
    );
    const daily = () => document.getElementById('backups-keep-daily') as HTMLInputElement;
    await typeInto(daily(), '0');
    await typeInto(document.getElementById('backups-keep-weekly') as HTMLInputElement, '200');
    await click(button('Save changes'));
    expect(alerts()).toContain(
      'Daily backups kept must be at least 1. Weekly backups kept must be at most 104.',
    );
    await typeInto(daily(), '7');
    expect(alerts()).toContain('Weekly backups kept must be at most 104.');
    expect(alerts().join(' ')).not.toContain('Daily backups kept');
  });

  it('turns copying files on and chooses how many are checked', async () => {
    current = status({
      settings: { ...status().settings, copyFiles: false },
    });
    await render();
    expect(document.body.textContent).toContain('Attachment files are not copied');
    expect(document.getElementById('backups-verify-files')).toBeNull();
    await click(document.getElementById('backups-copy-files') as HTMLElement);
    expect(document.getElementById('backups-verify-files')).not.toBeNull();
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/backups/settings', { copyFiles: true });
  });

  it('tests the saved destination', async () => {
    api.post.mockResolvedValueOnce({ ok: false, detail: 'Access Denied' });
    await render();
    await click(button('Test destination'));
    expect(api.post).toHaveBeenCalledWith('/admin/backups/test');
    expect(document.body.textContent).toContain('Access Denied');
  });

  it('is read-only for auditors', async () => {
    await render('auditor');
    for (const name of ['Back up now', 'Test destination', 'Save changes'])
      expect(findButton(name), name).toBeUndefined();
    const bucket = document.getElementById('backups-bucket') as HTMLInputElement;
    expect(bucket.closest('fieldset')?.disabled).toBe(true);
  });
});

describe('System health', () => {
  it('shows the backup and webhook rows and the read-only observability status', async () => {
    const { AdminHealthPage } = await import('../../src/routes/admin/health');
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/health')
        return {
          status: 'warn',
          checks: [
            {
              id: 'backups',
              label: 'Backups',
              status: 'error',
              detail: 'The latest backup failed',
            },
            { id: 'webhooks', label: 'Webhooks', status: 'ok', detail: '1 enabled; 0 pending' },
          ],
          observability: {
            metrics: true,
            tracing: false,
            tracingEndpoint: null,
          },
        };
      if (path === '/admin/lifecycle/jobs')
        return {
          jobs: [
            {
              name: 'attachment-orphan-reconciliation',
              intervalMs: 60_000,
              lastRun: {
                id: 'r1',
                jobName: 'attachment-orphan-reconciliation',
                status: 'success',
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 120,
                itemsProcessed: 3,
                errorMessage: null,
              },
            },
            // A daily job that has not run since the API started (#215).
            { name: 'retention.audit-log', intervalMs: 86_400_000, lastRun: null },
          ],
        };
      if (path === '/admin/lifecycle/storage-health')
        return {
          liveBytes: 0,
          liveFileCount: 0,
          pendingBytes: 0,
          pendingFileCount: 0,
          pendingDeletions: 0,
        };
      throw new Error(`Unexpected GET ${path}`);
    });
    ({ root } = await renderAdmin(<AdminHealthPage />, { role: 'auditor', path: '/admin/health' }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('The latest backup failed');
    expect(text).toContain('1 enabled; 0 pending');
    expect(text).toContain('Served at /metrics');
    expect(text).toContain('Set OTEL_EXPORTER_OTLP_ENDPOINT to export traces.');
    // A long job name and its run line can be cut short on a phone (#130).
    expect(text).toContain('attachment-orphan-reconciliation');
    expect(text).toContain('runs every minute');
    // Every registered job is listed, whether or not it has run (#215).
    expect(text).toContain('retention.audit-log');
    expect(text).toContain('Not run yet · runs every day');
    expect(untitledTruncations()).toEqual([]);
    // A tooltip cannot be read on a touch phone, where 18 of 28 run lines were
    // cut at "runs every…" (#215): the name and run line wrap instead.
    const lines = [...document.querySelectorAll('li p')].filter((line) =>
      /runs every|attachment-orphan-reconciliation/.test(line.textContent ?? ''),
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const style = await styleFor(line.className);
      expect(style['text-overflow'], line.textContent ?? '').toBeUndefined();
      expect(style['white-space'], line.textContent ?? '').not.toBe('nowrap');
    }
  });
});

describe('backup settings changes', () => {
  it('is empty for an unchanged form and maps cleared endpoints to null', () => {
    const saved = status({
      settings: {
        ...status().settings,
        s3: { ...status().settings.s3, endpoint: 'https://minio' },
      },
    });
    const draft = {
      enabled: true,
      hourUtc: 3,
      destination: 'separate' as const,
      prefix: 'oci-backups/',
      bucket: 'oci-backups',
      region: 'us-east-1',
      endpoint: 'https://minio',
      accessKeyId: 'AKIA',
      forcePathStyle: false,
      secretAccessKey: '',
      keepDaily: '7',
      keepWeekly: '4',
      copyFiles: true,
      verifyFiles: 'sample' as const,
    };
    expect(backupChanges(saved, draft)).toEqual({});
    expect(backupChanges(saved, { ...draft, copyFiles: false, verifyFiles: 'all' })).toEqual({
      copyFiles: false,
      verifyFiles: 'all',
    });
    expect(backupChanges(saved, { ...draft, endpoint: ' ', enabled: false, hourUtc: 5 })).toEqual({
      enabled: false,
      hourUtc: 5,
      s3: { endpoint: null },
    });
  });
});
