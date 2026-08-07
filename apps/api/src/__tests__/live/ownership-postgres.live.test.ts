import { randomUUID } from 'node:crypto';
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
 * Ownership and cascade behavior against real migrations. Mocked query chains
 * cannot prove that a foreign key actually cascades or that a unique index
 * actually rejects a duplicate, which is exactly what these guarantees rest on.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: thread and message ownership', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let owner: string;
  let stranger: string;

  beforeAll(async () => {
    live = await createLiveDatabase('ownership');
    db = live.db;
    organizationId = await seedOrganization(db);
    owner = await seedUser(db, organizationId, { email: 'owner@example.com' });
    stranger = await seedUser(db, organizationId, { email: 'stranger@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createThread(userId: string, title = 'Thread'): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${userId}, ${title})
      returning id
    `);
    if (!row) throw new Error('Failed to create thread');
    return row.id;
  }

  it('scopes a thread lookup to its owner', async () => {
    const threadId = await createThread(owner);

    const mine = await db.execute<{ id: string }>(
      sql`select id from thread where id = ${threadId} and user_id = ${owner}`,
    );
    const theirs = await db.execute<{ id: string }>(
      sql`select id from thread where id = ${threadId} and user_id = ${stranger}`,
    );

    expect(mine).toHaveLength(1);
    // The ownership predicate is what stops cross-user reads.
    expect(theirs).toHaveLength(0);
  });

  it('deletes a thread\u2019s messages along with the thread', async () => {
    const threadId = await createThread(owner);
    await db.execute(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${threadId}, ${owner}, 'user', '[]'::jsonb, 0)
    `);

    await db.execute(sql`delete from thread where id = ${threadId}`);

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from message where thread_id = ${threadId}`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('keeps message ordering stable by position', async () => {
    const threadId = await createThread(owner);
    for (const position of [2, 0, 1]) {
      await db.execute(sql`
        insert into message (thread_id, user_id, role, parts, position)
        values (${threadId}, ${owner}, 'user', '[]'::jsonb, ${position})
      `);
    }

    const rows = await db.execute<{ position: number }>(
      sql`select position from message where thread_id = ${threadId} order by position asc`,
    );
    expect(rows.map((row) => Number(row.position))).toEqual([0, 1, 2]);
  });

  it('removes a user\u2019s threads when the account is deleted', async () => {
    const doomed = await seedUser(db, organizationId);
    const threadId = await createThread(doomed);

    await db.execute(sql`delete from "user" where id = ${doomed}`);

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from thread where id = ${threadId}`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe.skipIf(!available)('live Postgres: share links', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('shares');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createShare(slug: string, expiresAt: Date | null): Promise<string> {
    const [thread] = await db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${userId}, 'Shared')
      returning id
    `);

    const [row] = await db.execute<{ id: string }>(sql`
      insert into share_link (thread_id, user_id, slug, expires_at)
      values (
        ${thread?.id}, ${userId}, ${slug},
        ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
      )
      returning id
    `);
    if (!row) throw new Error('Failed to create share link');
    return row.id;
  }

  it('rejects a duplicate slug', async () => {
    const slug = `slug-${randomUUID().slice(0, 8)}`;
    await createShare(slug, null);

    // Slugs are the entire address of a public share, so collisions must fail.
    await expect(createShare(slug, null)).rejects.toThrow();
  });

  it('separates live shares from expired ones by timestamp', async () => {
    await createShare(`live-${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3_600_000));
    await createShare(`dead-${randomUUID().slice(0, 8)}`, new Date(Date.now() - 3_600_000));

    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::bigint as count from share_link
      where user_id = ${userId} and (expires_at is null or expires_at > now())
    `);
    // The duplicate-slug test also left one non-expiring share behind.
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('revokes shares when the underlying thread is deleted', async () => {
    const slug = `orphan-${randomUUID().slice(0, 8)}`;
    const shareId = await createShare(slug, null);

    const [share] = await db.execute<{ thread_id: string }>(
      sql`select thread_id from share_link where id = ${shareId}`,
    );
    await db.execute(sql`delete from thread where id = ${share?.thread_id}`);

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from share_link where id = ${shareId}`,
    );
    // A share must never outlive the conversation it exposes.
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
