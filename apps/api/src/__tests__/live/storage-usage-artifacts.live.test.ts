import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { StorageDriver } from '../../services/storage/driver.js';

/**
 * Settings › Attachments after an upload that follows an artifact (#276),
 * through real PostgreSQL, the real upload, its counter triggers and
 * `getStorageUsage`, with local blobs in a temporary directory. The upload
 * wrote files plus artifact bytes into the file counter, and usage then
 * added the artifact bytes again: "Chat files" held the artifacts, and kept
 * them after everything was deleted.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as unknown as StorageDriver,
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
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'features'
      ? { attachments: true }
      : {
          driver: 'local',
          maxFileBytes: 1024,
          maxFilesPerMessage: 10,
          allowedMimeTypes: ['text/plain'],
          trashRetentionDays: 30,
        },
}));
vi.mock('../../services/storage/index.js', async (original) => ({
  ...(await original<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));

import { deleteAttachment, uploadAttachment } from '../../services/attachments/index.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';
import { getStorageUsage } from '../../services/storage/quota.js';

const available = await livePostgresAvailable();
const root = mkdtempSync(join(tmpdir(), 'oci-storage-usage-'));

describe.skipIf(!available)('live PostgreSQL: storage usage with artifacts', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('storage_usage_artifacts');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, state.organizationId);
    await LocalStorageDriver.ensureRoot(root);
    state.driver = new LocalStorageDriver(root);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const usage = () => getStorageUsage(userId, 'user');

  it('counts artifacts once after an upload, and nothing once all is deleted', async () => {
    // A conversation with a 282-byte artifact, then a 6-byte upload.
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId })
      .returning();
    const [message] = await pool.db
      .insert(schema.message)
      .values({ threadId: thread!.id, userId, role: 'assistant', position: 0, parts: [] })
      .returning();
    const [artifact] = await pool.db
      .insert(schema.artifact)
      .values({
        userId,
        threadId: thread!.id,
        messageId: message!.id,
        sourceKey: 'tool:1',
        title: 'Walk5 briefing',
        kind: 'markdown',
      })
      .returning();
    await pool.db.insert(schema.artifactVersion).values({
      artifactId: artifact!.id,
      version: 1,
      content: 'x'.repeat(282),
      sizeBytes: 282,
      source: 'reply',
    });
    const file = await uploadAttachment({
      userId,
      role: 'user',
      filename: 'file.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from('123456'),
    });
    expect(await usage()).toMatchObject({
      liveBytes: 6 + 282,
      liveFileCount: 1,
      breakdown: {
        chatFiles: { bytes: 6, count: 1 },
        projectFiles: { bytes: 0, count: 0 },
        artifacts: { bytes: 282, count: 1 },
      },
    });

    // Everything deleted: nothing is left in use.
    await deleteAttachment(file.id, userId);
    await pool.db.delete(schema.thread).where(eq(schema.thread.id, thread!.id));
    await pool.db.delete(schema.attachment);
    expect(await usage()).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      breakdown: { chatFiles: { bytes: 0, count: 0 }, artifacts: { bytes: 0, count: 0 } },
    });
  });
});
