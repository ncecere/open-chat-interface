import { schema } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// Backups switched off, as in the QA walk.
vi.mock('../../services/backups/settings.js', () => ({
  backupSettings: async () => ({ enabled: false }),
}));

const { backupHealthCheck } = await import('../../services/observability/health-checks.js');

describe.skipIf(!available)('live: backup health while backups are off', () => {
  let live: LiveDatabase;
  let organizationId: string;
  const now = new Date('2026-10-05T12:00:00Z');

  async function run(status: 'failed' | 'succeeded', startedAt: Date) {
    await live.db.insert(schema.backupRun).values({
      organizationId,
      trigger: 'manual',
      status,
      startedAt,
      destination: 'separate',
      keyPrefix: 'walk/',
      errorMessage:
        status === 'failed'
          ? 'Verification failed: the stored archive does not match what was written.'
          : null,
    });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('backup_health_off');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
  });
  beforeEach(async () => {
    await live.db.delete(schema.backupRun);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('warns about a backup that was just tried and failed', async () => {
    await run('failed', new Date(now.getTime() - 60 * 60_000));
    expect(await backupHealthCheck(now)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(
        'Off, and the latest backup (2026-10-05 11:00 UTC) failed: Verification failed',
      ),
    });
  });

  it('treats an old failure as history', async () => {
    await run('failed', new Date(now.getTime() - 10 * 24 * 60 * 60_000));
    expect(await backupHealthCheck(now)).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^Off\./),
    });
  });

  it('is ok when nothing has failed', async () => {
    await run('succeeded', new Date(now.getTime() - 60 * 60_000));
    expect(await backupHealthCheck(now)).toMatchObject({ status: 'ok' });
  });
});
