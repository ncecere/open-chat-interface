import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Uploads that were never sent (#297): attached in a composer that was then
 * left (New Chat, another conversation) stayed stored, counted against the
 * person's storage and listed exactly like sent files, and after a day made
 * System health warn. The composer now discards them through
 * `DELETE /api/attachments/:id/unsent`, which keeps a file sent meanwhile; the
 * Attachments list marks unsent ones; and the hourly unused-items job deletes
 * uploads unsent for a day. Real routes, real PostgreSQL (with its storage
 * triggers) and local storage.
 */
const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-attach-unsent-'));

const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'storage') {
      return {
        driver: 'local',
        maxFileBytes: 20 * 1024 * 1024,
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
      };
    }
    if (key === 'features') return { attachments: true };
    return {};
  },
  invalidateSettingsCache: () => {},
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), STORAGE_LOCAL_PATH: storageRoot }),
  };
});

const { attachmentRoutes } = await import('../../routes/attachments.js');
const { purgeUnsentUploads } = await import('../../services/attachments/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
type AppBindings = import('../../middleware/context.js').AppBindings;

function appFor(userId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'user@example.com',
      name: 'User',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api/attachments', attachmentRoutes);
  return app;
}

describe.skipIf(!available)('live: uploads never sent (#297)', () => {
  let live: LiveDatabase;
  let owner: string;
  let stranger: string;

  beforeAll(async () => {
    live = await createLiveDatabase('attachments_unsent');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });
  beforeEach(async () => {
    owner = await seedUser(live.db, state.organizationId);
    stranger = await seedUser(live.db, state.organizationId);
  });
  afterAll(async () => {
    await live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function upload(name = 'walk6-notes.txt', userId = owner) {
    const form = new FormData();
    form.append(
      'files',
      new File(['The lab mascot is OSPREY-ZETA.'], name, { type: 'text/plain' }),
    );
    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(201);
    const { attachments } = (await response.json()) as { attachments: { id: string }[] };
    return attachments[0]!.id;
  }
  async function send(fileId: string) {
    const [thread] = await live.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, title: 'Sent' })
      .returning();
    const [message] = await live.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId: owner,
        role: 'user',
        position: 0,
        parts: [
          { type: 'text', text: 'Read this' },
          { type: 'data-attachment', data: { id: fileId, filename: 'walk6-notes.txt' } },
        ],
      })
      .returning();
    await live.db
      .update(schema.attachment)
      .set({ messageId: message!.id })
      .where(eq(schema.attachment.id, fileId));
    return message!;
  }
  async function listed(userId = owner) {
    const response = await appFor(userId).request('/api/attachments');
    const { attachments } = (await response.json()) as {
      attachments: { id: string; unsent: boolean }[];
    };
    return attachments;
  }
  async function usage(userId = owner) {
    const [row] = await live.db
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, userId));
    return { live: row?.liveFileCount ?? 0, trash: row?.pendingFileCount ?? 0 };
  }
  async function file(id: string) {
    const [row] = await live.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, id));
    return row;
  }
  const discard = (id: string, userId = owner) =>
    appFor(userId).request(`/api/attachments/${id}/unsent`, { method: 'DELETE' });
  /** Makes a file look uploaded `hours` ago. */
  const age = (id: string, hours: number) =>
    live.db
      .update(schema.attachment)
      .set({ createdAt: new Date(Date.now() - hours * 60 * 60 * 1000) })
      .where(eq(schema.attachment.id, id));

  it('lists an unsent upload as not sent, and a sent one as sent', async () => {
    const unsent = await upload('draft.txt');
    const sent = await upload('sent.txt');
    await send(sent);
    expect(Object.fromEntries((await listed()).map((entry) => [entry.id, entry.unsent]))).toEqual({
      [unsent]: true,
      [sent]: false,
    });
  });

  it('discards an unsent upload as its × does: trashed, uncounted and unlisted', async () => {
    const id = await upload();
    expect(await usage()).toEqual({ live: 1, trash: 0 });
    const response = await discard(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect((await file(id))?.deletedAt).not.toBeNull();
    expect(await usage()).toEqual({ live: 0, trash: 1 });
    expect(await listed()).toEqual([]);
  });

  it('keeps a file that was sent meanwhile, and its message', async () => {
    const id = await upload();
    const message = await send(id);
    const response = await discard(id);
    expect(await response.json()).toEqual({ removed: false });
    expect((await file(id))?.deletedAt).toBeNull();
    const [after] = await live.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, message.id));
    expect(after?.parts).toEqual(message.parts);
    expect(await usage()).toEqual({ live: 1, trash: 0 });
  });

  it('never discards someone else’s upload', async () => {
    const id = await upload('theirs.txt', stranger);
    expect(await (await discard(id, owner)).json()).toEqual({ removed: false });
    expect((await file(id))?.deletedAt).toBeNull();
  });

  it('deletes uploads unsent for a day, and nothing else', async () => {
    const old = await upload('old-draft.txt');
    const young = await upload('young-draft.txt');
    const oldSent = await upload('old-sent.txt');
    await send(oldSent);
    const held = await upload('held.txt', stranger);
    for (const id of [old, oldSent, held]) await age(id, 25);
    await live.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: stranger,
      userEmail: 'held@example.com',
      reason: 'Fix6 test hold',
    });

    expect(await usage()).toEqual({ live: 3, trash: 0 });
    const oldKey = (await file(old))!.storageKey;
    expect(await purgeUnsentUploads()).toBeGreaterThanOrEqual(1);
    expect(await file(old)).toBeUndefined();
    expect(await file(young)).toBeDefined();
    expect(await file(oldSent)).toBeDefined();
    expect(await file(held)).toBeDefined();
    // The delete trigger releases the storage it used.
    expect(await usage()).toEqual({ live: 2, trash: 0 });
    // Recorded, as every deletion is.
    const events = await live.db.execute<{ reason: string }>(sql`
      select metadata->'deletion'->>'reason' as reason from audit_log
      where action = 'attachment.delete' and target_id = ${old}`);
    expect(events.map((event) => event.reason)).toEqual(['unused_expiry']);
    // Its object is queued for removal from storage.
    const queued = await live.db
      .select()
      .from(schema.deletedObject)
      .where(eq(schema.deletedObject.storageKey, oldKey));
    expect(queued).toHaveLength(1);
  });
});
