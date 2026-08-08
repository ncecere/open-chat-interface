import { type Database, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The blob-deletion queue against real migrations.
 *
 * This is the guarantee mocks cannot express: PostgreSQL executes
 * `ON DELETE CASCADE` without ever calling the application, so a cascade used
 * to remove an attachment row and leave its object in storage forever. Only a
 * database trigger closes that hole, and only a real database can prove the
 * trigger fires on every deletion path.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: storage object lifecycle', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('storage_lifecycle');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId, { email: 'owner@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createThread(): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${userId}, 'Thread')
      returning id
    `);
    if (!row) throw new Error('Failed to create thread');
    return row.id;
  }

  async function createMessage(threadId: string): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${threadId}, ${userId}, 'user', '[]'::jsonb, 0)
      returning id
    `);
    if (!row) throw new Error('Failed to create message');
    return row.id;
  }

  async function createAttachment(messageId: string | null, storageKey: string): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into attachment (organization_id, user_id, message_id, filename, mime_type, size_bytes, storage_key)
      values (${organizationId}, ${userId}, ${messageId}, 'file.png', 'image/png', 2048, ${storageKey})
      returning id
    `);
    if (!row) throw new Error('Failed to create attachment');
    return row.id;
  }

  async function queuedKeys(): Promise<string[]> {
    const rows = await db.execute<{ storage_key: string }>(
      sql`select storage_key from deleted_object where deleted_at is null`,
    );
    return rows.map((row) => row.storage_key);
  }

  it('queues the blob when an attachment is deleted directly', async () => {
    await createAttachment(null, 'user/direct.png');
    await db.execute(sql`delete from attachment where storage_key = 'user/direct.png'`);

    expect(await queuedKeys()).toContain('user/direct.png');
  });

  it('queues the blob when a thread cascade removes the attachment', async () => {
    const threadId = await createThread();
    const messageId = await createMessage(threadId);
    await createAttachment(messageId, 'user/cascade-thread.png');

    // The application never sees this deletion; only the trigger can catch it.
    await db.execute(sql`delete from thread where id = ${threadId}`);

    expect(await queuedKeys()).toContain('user/cascade-thread.png');
  });

  it('queues the blob when deleting a user cascades everything they own', async () => {
    const doomed = await seedUser(db, organizationId, { email: 'doomed@example.com' });
    await db.execute(sql`
      insert into attachment (organization_id, user_id, filename, mime_type, size_bytes, storage_key)
      values (${organizationId}, ${doomed}, 'f.png', 'image/png', 1024, 'user/cascade-user.png')
    `);

    await db.execute(sql`delete from "user" where id = ${doomed}`);

    expect(await queuedKeys()).toContain('user/cascade-user.png');
  });

  it('records the size so freed space can be reported', async () => {
    await createAttachment(null, 'user/sized.png');
    await db.execute(sql`delete from attachment where storage_key = 'user/sized.png'`);

    const [row] = await db.execute<{ size_bytes: string }>(
      sql`select size_bytes from deleted_object where storage_key = 'user/sized.png'`,
    );
    expect(Number(row?.size_bytes)).toBe(2048);
  });

  it('does not queue an upload that never got a real storage key', async () => {
    // A failed upload leaves the placeholder; there is no object to remove.
    await createAttachment(null, 'pending');
    await db.execute(sql`delete from attachment where storage_key = 'pending'`);

    expect(await queuedKeys()).not.toContain('pending');
  });

  it('keeps a soft-deleted attachment out of the queue until it is purged', async () => {
    const id = await createAttachment(null, 'user/trashed.png');
    await db.execute(sql`update attachment set deleted_at = now() where id = ${id}`);

    // Still restorable, so the object must survive.
    expect(await queuedKeys()).not.toContain('user/trashed.png');

    await db.execute(sql`delete from attachment where id = ${id}`);
    expect(await queuedKeys()).toContain('user/trashed.png');
  });
});
