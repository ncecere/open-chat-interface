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
 * Acceptable use policy versioning and acceptance.
 *
 * This is a compliance record: it answers who agreed to which wording and
 * when. The guarantees that make it trustworthy are enforced by the schema, so
 * they are exercised against a real database rather than described in prose.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: acceptable use policy', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;
  let firstVersionId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('usage_policy');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId, { email: 'reader@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function publish(version: number, body: string): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into usage_policy (organization_id, version, title, body, published_at)
      values (${organizationId}, ${version}, 'Acceptable use', ${body}, now())
      returning id
    `);
    if (!row) throw new Error('Failed to publish');
    return row.id;
  }

  /** The version in force is the highest published one. */
  async function currentVersion(): Promise<number | null> {
    const [row] = await db.execute<{ version: number }>(sql`
      select version from usage_policy
      where published_at is not null
      order by version desc limit 1
    `);
    return row?.version ?? null;
  }

  async function hasAccepted(version: number): Promise<boolean> {
    const [row] = await db.execute<{ count: string }>(sql`
      select count(*)::bigint as count
      from usage_policy_acceptance a
      join usage_policy p on p.id = a.policy_id
      where a.user_id = ${userId} and p.version = ${version}
    `);
    return Number(row?.count) > 0;
  }

  it('treats the highest published version as the one in force', async () => {
    firstVersionId = await publish(1, 'Version one text');
    expect(await currentVersion()).toBe(1);
  });

  it('records an acceptance against a specific version', async () => {
    await db.execute(sql`
      insert into usage_policy_acceptance (policy_id, user_id, policy_version, ip_address)
      values (${firstVersionId}, ${userId}, 1, '198.51.100.7')
    `);

    const [row] = await db.execute<{ policy_version: number; ip_address: string }>(
      sql`select policy_version, ip_address from usage_policy_acceptance where user_id = ${userId}`,
    );
    expect(row?.policy_version).toBe(1);
    expect(row?.ip_address).toBe('198.51.100.7');
  });

  it('treats a repeated acceptance as harmless', async () => {
    await db.execute(sql`
      insert into usage_policy_acceptance (policy_id, user_id, policy_version)
      values (${firstVersionId}, ${userId}, 1)
      on conflict (policy_id, user_id) do nothing
    `);

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from usage_policy_acceptance where user_id = ${userId}`,
    );
    expect(Number(row?.count)).toBe(1);
  });

  it('needs acceptance again once a newer version is published', async () => {
    await publish(2, 'Version two text');

    expect(await currentVersion()).toBe(2);
    // The earlier acceptance stands, but it is not acceptance of what is now
    // in force, which is what re-prompts the user.
    expect(await hasAccepted(1)).toBe(true);
    expect(await hasAccepted(2)).toBe(false);
  });

  it('refuses to delete a version somebody accepted', async () => {
    // Deleting it would destroy the record of what they agreed to, so the
    // foreign key restricts rather than cascades.
    await expect(
      db.execute(sql`delete from usage_policy where id = ${firstVersionId}`),
    ).rejects.toThrow();
  });

  it('keeps the wording of an accepted version unchanged', async () => {
    const [row] = await db.execute<{ body: string }>(
      sql`select body from usage_policy where id = ${firstVersionId}`,
    );
    // A change is a new version, so the accepted text stays as it was.
    expect(row?.body).toBe('Version one text');
  });

  it('rejects a duplicate version number for one organization', async () => {
    await expect(publish(2, 'Conflicting')).rejects.toThrow();
  });

  it('removes acceptances when the person is deleted', async () => {
    const leaving = await seedUser(db, organizationId, { email: 'leaving@example.com' });
    await db.execute(sql`
      insert into usage_policy_acceptance (policy_id, user_id, policy_version)
      values (${firstVersionId}, ${leaving}, 1)
    `);

    await db.execute(sql`delete from "user" where id = ${leaving}`);

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from usage_policy_acceptance where user_id = ${leaving}`,
    );
    expect(Number(row?.count)).toBe(0);
  });
});
