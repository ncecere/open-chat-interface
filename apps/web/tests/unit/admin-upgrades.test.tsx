// @vitest-environment happy-dom
import type { BackgroundMigrationSummary, UpgradeReport } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorkSection, UpgradesSection } from '../../src/components/admin/upgrades';
import { cleanup, click, findButton, renderAdmin, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const REPORT: UpgradeReport = {
  generatedAt: '2026-10-04T00:00:00.000Z',
  bundled: {
    version: '0.11.0',
    latestMigration: '0039_three_phase_migrations',
    migrations: 40,
    postSteps: 1,
    backgroundMigrations: 1,
  },
  database: {
    fresh: false,
    latestMigration: '0039_three_phase_migrations',
    release: '0.11.0',
    applied: 40,
    unknownNewer: 0,
  },
  preDeploy: [],
  postDeploy: [
    {
      name: '0001_message_created_at_index',
      release: '0.11.0',
      state: 'started',
      attempts: 2,
      lastError: 'canceling statement due to lock timeout',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      statement: {
        summary:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_created_at_idx" ON "message" ("created_at")',
        cost: 'concurrent-index',
        tables: [{ name: 'public.message', exists: true, rows: 500_000, bytes: 950_000_000 }],
        fast: true,
        reason: null,
      },
      index: {
        name: 'message_created_at_idx',
        table: 'public.message',
        estimatedBytes: 11_534_336,
        sizedFromStatistics: true,
        invalidExists: true,
        exists: false,
      },
    },
  ],
  background: [],
  requirements: [],
  indexes: { toBuild: 1, estimatedBytes: 11_534_336, invalid: ['public.message_created_at_idx'] },
  verdict: {
    mode: 'rolling',
    summary: 'Run `migrate --post`: the release is deployed and its post-deploy work is waiting.',
    reasons: ['1 post-deploy step(s) to run with `migrate --post` once every replica runs 0.11.0.'],
  },
};

function migration(
  overrides: Partial<BackgroundMigrationSummary> = {},
): BackgroundMigrationSummary {
  return {
    name: '0.11.backfill',
    description: 'Fills the new column.',
    release: '0.11.0',
    table: 'public.message',
    bundled: true,
    status: 'running',
    cursor: '40000000-0000-4000-8000-000000000000',
    batchSize: 1_000,
    pauseMs: 50,
    rowsProcessed: 125_000,
    batches: 125,
    estimatedRows: 500_000,
    tableBytes: 950_000_000,
    progress: 0.25,
    attempts: 0,
    lastError: null,
    leaseOwner: 'api-1:1:abc',
    leaseUntil: null,
    nextRunAt: null,
    throttledReason: 'Replication lag 12 s is over 10 s',
    throttledAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({});
  api.patch.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('Upgrades', () => {
  it('shows the verdict, the release and schema, and each post-deploy step', async () => {
    api.get.mockResolvedValue(REPORT);
    ({ root } = await renderAdmin(<UpgradesSection />));
    expect(api.get).toHaveBeenCalledWith('/admin/migrations/upgrade');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Rolling upgrade');
    expect(text).toContain('Run `migrate --post`: the release is deployed');
    expect(text).toContain('0.11.0');
    expect(text).toContain('0039_three_phase_migrations');
    expect(text).toContain('0001_message_created_at_index');
    expect(text).toContain('Started, not finished (2 attempts)');
    expect(text).toContain('public.message: 500,000 rows, 906.0 MB');
    expect(text).toContain(
      'Builds message_created_at_idx, about 11.0 MB; an interrupted build will be dropped and rebuilt',
    );
    expect(text).toContain('canceling statement due to lock timeout');
    expect(text).toContain('Left by interrupted concurrent builds: public.message_created_at_idx');
  });

  it('names slow pre-deploy work and unfinished requirements', async () => {
    api.get.mockResolvedValue({
      ...REPORT,
      postDeploy: [],
      indexes: { toBuild: 0, estimatedBytes: 0, invalid: [] },
      preDeploy: [
        {
          tag: '0040_slow',
          release: '0.12.0',
          fast: false,
          statements: [
            {
              summary: 'CREATE INDEX x ON message (y)',
              cost: 'index',
              tables: [],
              fast: false,
              reason:
                'builds an index while blocking writes to public.message (500,000 rows, 906 MB)',
            },
          ],
        },
      ],
      requirements: [
        {
          kind: 'background-migration',
          name: '0.11.backfill',
          requiredBy: '0.12.0',
          state: 'running',
        },
      ],
      verdict: {
        mode: 'blocked',
        summary: 'Cannot upgrade this database with this release yet.',
        reasons: [],
      },
    } satisfies UpgradeReport);
    ({ root } = await renderAdmin(<UpgradesSection />));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Blocked');
    expect(text).toContain('1 pre-deploy migration(s) not applied');
    expect(text).toContain('0040_slow: builds an index while blocking writes');
    expect(text).toContain('0.11.backfill (running), required by 0.12.0');
  });
});

describe('Background work', () => {
  it('shows progress and lets an administrator pause and change the pace', async () => {
    api.get.mockResolvedValue({ migrations: [migration()] });
    ({ root } = await renderAdmin(<BackgroundWorkSection />));
    const bar = document.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('25');
    expect(bar?.getAttribute('aria-valuetext')).toBe('125,000 of about 500,000 rows (25%)');
    expect(document.body.textContent).toContain('waiting: Replication lag 12 s is over 10 s');

    await click(findButton('Pause 0.11.backfill')!);
    expect(api.post).toHaveBeenCalledWith('/admin/migrations/background/0.11.backfill/pause');

    const batch = document.querySelector<HTMLInputElement>('#migration-0-11-backfill-batch')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(batch, '250');
      batch.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(findButton('Save')!);
    expect(api.patch).toHaveBeenCalledWith('/admin/migrations/background/0.11.backfill', {
      batchSize: 250,
      pauseMs: 50,
    });
  });

  it('offers resume for a failed migration and shows its error', async () => {
    api.get.mockResolvedValue({
      migrations: [
        migration({ status: 'failed', attempts: 5, lastError: 'deadlock detected', progress: 0.5 }),
      ],
    });
    ({ root } = await renderAdmin(<BackgroundWorkSection />));
    expect(document.body.textContent).toContain('Last error (5 in a row): deadlock detected');
    await click(findButton('Resume 0.11.backfill')!);
    expect(api.post).toHaveBeenCalledWith('/admin/migrations/background/0.11.backfill/resume');
  });

  it('counts rows without "of about" when there is no estimate (#263)', async () => {
    api.get.mockResolvedValue({
      migrations: [
        migration({ status: 'finished', estimatedRows: null, rowsProcessed: 9, progress: 1 }),
        migration({
          name: '0.11.one',
          status: 'finished',
          estimatedRows: null,
          rowsProcessed: 1,
          progress: 1,
        }),
      ],
    });
    ({ root } = await renderAdmin(<BackgroundWorkSection />));
    const bars = [...document.querySelectorAll('[role="progressbar"]')].map((bar) =>
      bar.getAttribute('aria-valuetext'),
    );
    expect(bars).toEqual(['9 rows processed (100%)', '1 row processed (100%)']);
    expect(document.body.textContent).not.toContain('of about');
  });

  it('is read-only for auditors', async () => {
    api.get.mockResolvedValue({ migrations: [migration()] });
    ({ root } = await renderAdmin(<BackgroundWorkSection />, { role: 'auditor' }));
    expect(findButton('Pause 0.11.backfill')).toBeUndefined();
    expect(findButton('Save')).toBeUndefined();
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('explains unscheduled, unknown and absent migrations', async () => {
    api.get.mockResolvedValue({
      migrations: [
        migration({ status: 'not_scheduled', progress: null }),
        migration({ name: '0.12.next', bundled: false, description: null, status: 'pending' }),
      ],
    });
    ({ root } = await renderAdmin(<BackgroundWorkSection />));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Runs after `migrate --post` schedules it.');
    expect(text).toContain('Scheduled by a newer release; this release cannot run it.');
    expect(findButton('Pause 0.12.next')).toBeUndefined();
    await cleanup(root!);

    api.get.mockResolvedValue({ migrations: [] });
    ({ root } = await renderAdmin(<BackgroundWorkSection />));
    expect(document.body.textContent).toContain('No background migrations.');
  });
});
