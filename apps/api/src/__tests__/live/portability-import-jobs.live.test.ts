import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '@oci/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { livePostgresAvailable } from '../../../test/live-postgres.js';
import {
  chatgptZip,
  claudeV1,
  type PortabilityImportContext,
  usePortabilityImportSuite,
} from '../../../test/portability-import.fixtures.js';

/**
 * ChatGPT and Claude imports through the real upload route, job processing,
 * PostgreSQL and local storage. Fixtures are small synthetic exports
 * (test/portability-import.fixtures.ts), shaped after the documented quirks.
 * Running imports: resuming after restarts, lost connections and shutdowns,
 * per-person imports, one at a time, and the upload and storage limits.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  runJobNow: null as unknown as ReturnType<typeof vi.fn<(name: string) => Promise<number>>>,
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  consumeRateLimit: async () => ({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 1 }),
}));
vi.mock('../../services/jobs/index.js', () => ({
  runJobNow: (name: string) => state.runJobNow(name),
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'storage'
      ? {
          driver: 'local',
          maxFileBytes: 10 * 1024 * 1024,
          maxFilesPerMessage: 10,
          allowedMimeTypes: ['text/plain'],
          s3: {
            bucket: '',
            region: 'us-east-1',
            endpoint: null,
            accessKeyId: '',
            encryptedSecretAccessKey: null,
            forcePathStyle: false,
          },
        }
      : {},
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      STORAGE_LOCAL_PATH: storageRoot,
      IMPORT_MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
    }),
  };
});

const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-import-'));
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
const { processPendingImports } = await import('../../services/portability/imports.js');

describe.skipIf(!available)('live Postgres: ChatGPT and Claude import', () => {
  const suite = usePortabilityImportSuite(state, storageRoot);
  const { appFor, upload, importsFor, threadsFor } = suite;
  let live: PortabilityImportContext['live'];
  let userId: PortabilityImportContext['userId'];
  let otherId: PortabilityImportContext['otherId'];
  beforeAll(() => {
    ({ live, userId, otherId } = suite.ctx);
  });

  it('resumes imports interrupted by a restart, without stealing live ones', async () => {
    const driver = new LocalStorageDriver(storageRoot);
    const body = Buffer.from(JSON.stringify([claudeV1]));
    async function seed(owner: string, status: string, updatedAt: string) {
      const id = crypto.randomUUID();
      const key = `imports/${owner}/${id}`;
      await driver.put(key, body, 'application/json');
      await live.db.execute(sql`
        insert into conversation_import (id, organization_id, user_id, status, filename, size_bytes,
                                         storage_key, attempts, updated_at)
        values (${id}, ${state.organizationId}, ${owner}, ${status}, 'conversations.json',
                ${body.byteLength}, ${key}, ${status === 'running' ? 1 : 0}, ${updatedAt}::timestamptz)
      `);
      return id;
    }

    const now = new Date();
    const abandoned = await seed(
      userId,
      'running',
      new Date(now.getTime() - 60 * 60_000).toISOString(),
    );
    const live1 = await seed(otherId, 'running', now.toISOString());
    // Queued behind the other person's genuinely running import.
    const waiting = await seed(otherId, 'pending', now.toISOString());

    expect(await processPendingImports()).toBe(1);

    const rows = await live.db.execute<{ id: string; status: string; attempts: number }>(
      sql`select id, status, attempts from conversation_import`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(abandoned)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(byId.get(live1)?.status).toBe('running');
    expect(byId.get(waiting)?.status).toBe('pending');
    expect(await threadsFor(userId)).toHaveLength(1);
  });

  it('requeues an import cut short by a lost database connection, and resumes it (v0.11)', async () => {
    // The second conversation's insert meets a failover: SQLSTATE 57P01, as
    // the server sends when a primary shuts down.
    await live.db.execute(
      sql.raw(`
      create function failover_on_second_thread() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from thread where user_id = new.user_id) then
          raise exception 'terminating connection due to administrator command'
            using errcode = 'admin_shutdown';
        end if;
        return new;
      end $$;
      create trigger failover_on_second_thread before insert on thread
        for each row execute function failover_on_second_thread();
    `),
    );
    try {
      expect((await upload(userId, chatgptZip())).status).toBe(202);
      await processPendingImports();
      // Back in the queue, not failed, and its attempt not used up.
      const [requeued] = await live.db.execute<{ status: string; attempts: number }>(
        sql`select status, attempts from conversation_import where user_id = ${userId}`,
      );
      expect(requeued).toEqual({ status: 'pending', attempts: 0 });
      expect(await threadsFor(userId)).toHaveLength(1);
    } finally {
      await live.db.execute(
        sql.raw(`drop trigger failover_on_second_thread on thread;
          drop function failover_on_second_thread();`),
      );
    }
    expect(await processPendingImports()).toBe(1);
    const [record] = await importsFor(userId);
    // The first conversation is recognised and skipped; the second imported.
    expect(record).toMatchObject({
      status: 'completed',
      importedCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });
    expect(await threadsFor(userId)).toHaveLength(2);
  });

  it('stops a long import at its next checkpoint when the worker shuts down, and resumes it (v0.11)', async () => {
    const { beginDrain, resetDrainForTests } = await import('../../lib/drain.js');
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...claudeV1,
      uuid: `claude-many-${index}`,
    }));
    expect((await upload(userId, JSON.stringify(many), 'conversations.json')).status).toBe(202);
    beginDrain('SIGTERM');
    try {
      await processPendingImports();
    } finally {
      resetDrainForTests();
    }
    // The 25 conversations before the checkpoint are stored; the rest wait.
    const [paused] = await live.db.execute<{ status: string; attempts: number }>(
      sql`select status, attempts from conversation_import where user_id = ${userId}`,
    );
    expect(paused).toEqual({ status: 'pending', attempts: 0 });
    expect(await threadsFor(userId)).toHaveLength(25);
    expect(await processPendingImports()).toBe(1);
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'completed', importedCount: 5, skippedCount: 25 });
  });

  it('gives up on an import that keeps crashing', async () => {
    const id = crypto.randomUUID();
    await live.db.execute(sql`
      insert into conversation_import (id, organization_id, user_id, status, filename, storage_key,
                                       attempts, updated_at)
      values (${id}, ${state.organizationId}, ${userId}, 'running', 'x.zip', ${`imports/${userId}/${id}`},
              3, now() - interval '1 hour')
    `);
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/stopped unexpectedly/);
  });

  it('keeps imports per person', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports();
    await upload(otherId, chatgptZip());
    await processPendingImports();

    // The same source conversation is new for someone else.
    expect(await threadsFor(otherId)).toHaveLength(2);
    expect(await threadsFor(userId)).toHaveLength(2);

    const mine = await importsFor(userId);
    const theirs = await importsFor(otherId);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);

    const response = await appFor(otherId).request(`/api/me/imports/${mine[0]?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    expect(await importsFor(userId)).toHaveLength(1);
  });

  it('allows one import at a time and lets a queued one be cancelled', async () => {
    const first = await upload(userId, chatgptZip());
    expect(first.status).toBe(202);
    const { import: queued } = (await first.json()) as { import: { id: string } };
    const [row] = await live.db.execute<{ storage_key: string }>(
      sql`select storage_key from conversation_import where id = ${queued.id}`,
    );

    const second = await upload(userId, chatgptZip());
    expect(second.status).toBe(409);

    const removed = await appFor(userId).request(`/api/me/imports/${queued.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(await importsFor(userId)).toHaveLength(0);
    expect(existsSync(join(storageRoot, row?.storage_key as string))).toBe(false);

    expect((await upload(userId, chatgptZip())).status).toBe(202);
  });

  it('refuses to remove a running import', async () => {
    await upload(userId, chatgptZip());
    const [row] = await live.db.execute<{ id: string }>(
      sql`update conversation_import set status = 'running', updated_at = now() returning id`,
    );
    const response = await appFor(userId).request(`/api/me/imports/${row?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
  });

  it('enforces the upload size limit and the storage allowance', async () => {
    const tooBig = await upload(userId, Buffer.alloc(3 * 1024 * 1024, 1));
    expect(tooBig.status).toBe(413);

    await live.db.execute(sql`
      insert into storage_policy (organization_id, role, max_total_bytes)
      values (${state.organizationId}, 'user', 100)
    `);
    const overQuota = await upload(userId, chatgptZip());
    expect(overQuota.status).toBe(422);
    expect(await importsFor(userId)).toHaveLength(0);
  });
});
