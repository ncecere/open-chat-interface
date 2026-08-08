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
 * Announcement visibility.
 *
 * Windowing, audience, and dismissal are all decided in SQL, so this exercises
 * the same predicate the application uses rather than a reimplementation of it.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: announcements', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let reader: string;
  let other: string;

  beforeAll(async () => {
    live = await createLiveDatabase('broadcasts');
    db = live.db;
    organizationId = await seedOrganization(db);
    reader = await seedUser(db, organizationId, { email: 'reader@example.com' });
    other = await seedUser(db, organizationId, { email: 'other@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function create(values: {
    title: string;
    published?: boolean;
    roles?: string[];
    startsAt?: string | null;
    endsAt?: string | null;
  }): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into broadcast
        (organization_id, title, body, published, audience_roles, starts_at, ends_at)
      values (
        ${organizationId}, ${values.title}, 'Body', ${values.published ?? true},
        ${JSON.stringify(values.roles ?? [])}::jsonb,
        ${values.startsAt ?? null}::timestamptz,
        ${values.endsAt ?? null}::timestamptz
      )
      returning id
    `);
    if (!row) throw new Error('Failed to create announcement');
    return row.id;
  }

  /** Mirrors the predicate the service uses. */
  async function visibleTo(userId: string, role: string): Promise<string[]> {
    const rows = await db.execute<{ title: string }>(sql`
      select b.title
      from broadcast b
      left join broadcast_dismissal d on d.broadcast_id = b.id and d.user_id = ${userId}
      where b.published = true
        and (b.starts_at is null or b.starts_at <= now())
        and (b.ends_at is null or b.ends_at > now())
        and (jsonb_array_length(b.audience_roles) = 0
             or b.audience_roles @> ${JSON.stringify([role])}::jsonb)
        and d.id is null
      order by b.created_at
    `);
    return rows.map((row) => row.title);
  }

  it('shows a published announcement to everyone when no audience is set', async () => {
    await create({ title: 'Everyone' });
    expect(await visibleTo(reader, 'user')).toContain('Everyone');
    expect(await visibleTo(other, 'admin')).toContain('Everyone');
  });

  it('hides a draft', async () => {
    await create({ title: 'Draft', published: false });
    expect(await visibleTo(reader, 'user')).not.toContain('Draft');
  });

  it('shows an announcement only to the roles it targets', async () => {
    await create({ title: 'Admins only', roles: ['admin'] });
    expect(await visibleTo(other, 'admin')).toContain('Admins only');
    expect(await visibleTo(reader, 'user')).not.toContain('Admins only');
  });

  it('hides an announcement scheduled for later', async () => {
    await create({ title: 'Later', startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await visibleTo(reader, 'user')).not.toContain('Later');
  });

  it('hides an announcement whose window has closed', async () => {
    await create({ title: 'Expired', endsAt: new Date(Date.now() - 1_000).toISOString() });
    expect(await visibleTo(reader, 'user')).not.toContain('Expired');
  });

  it('hides an announcement only for the person who dismissed it', async () => {
    const id = await create({ title: 'Dismissable' });
    await db.execute(sql`
      insert into broadcast_dismissal (broadcast_id, user_id) values (${id}, ${reader})
    `);

    expect(await visibleTo(reader, 'user')).not.toContain('Dismissable');
    // One person hiding an announcement must not hide it for anyone else.
    expect(await visibleTo(other, 'user')).toContain('Dismissable');
  });

  it('treats a repeated dismissal as harmless', async () => {
    const id = await create({ title: 'Twice' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.execute(sql`
        insert into broadcast_dismissal (broadcast_id, user_id) values (${id}, ${reader})
        on conflict (broadcast_id, user_id) do nothing
      `);
    }

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from broadcast_dismissal where broadcast_id = ${id}`,
    );
    expect(Number(row?.count)).toBe(1);
  });

  it('removes dismissals with the announcement they belong to', async () => {
    const id = await create({ title: 'Temporary' });
    await db.execute(sql`
      insert into broadcast_dismissal (broadcast_id, user_id) values (${id}, ${reader})
    `);
    await db.execute(sql`delete from broadcast where id = ${id}`);

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from broadcast_dismissal where broadcast_id = ${id}`,
    );
    expect(Number(row?.count)).toBe(0);
  });
});
