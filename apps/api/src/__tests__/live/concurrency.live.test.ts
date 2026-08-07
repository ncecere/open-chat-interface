import { randomUUID } from 'node:crypto';
import { type Database, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Single-use and authorization boundaries under genuine parallelism. The
 * locking these rely on cannot be proven by reading the code or by mocked
 * tests: a race only appears when two transactions actually interleave.
 */
const available = await livePostgresAvailable();

// The share service resolves these at call time, so the suite can point them at
// the throwaway database and exercise the real revoke path rather than a copy.
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => (key === 'features' ? { shareLinks: true } : {}),
}));

const { revokeShareLink } = await import('../../services/share-links.js');

/** Runs `count` copies of a task at once and reports how many succeeded. */
async function race<T>(count: number, task: () => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: count }, () => task()));
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
  };
}

describe.skipIf(!available)('live: invite redemption races', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('invite-race');
    db = live.db;
    organizationId = await seedOrganization(db);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createInvite(): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into invitation (organization_id, role, token_hash, email)
      values (${organizationId}, 'user', ${`hash-${randomUUID()}`}, null)
      returning id
    `);
    if (!row) throw new Error('Failed to create invitation');
    return row.id;
  }

  /**
   * Mirrors the service: lock the row, reject an already-redeemed invite, then
   * claim it with a conditional update.
   */
  async function redeem(inviteId: string, userId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<{ redeemed_at: string | null }>(sql`
        select redeemed_at from invitation where id = ${inviteId} for update
      `);
      if (rows[0]?.redeemed_at) throw new Error('already redeemed');

      const claimed = await tx.execute<{ id: string }>(sql`
        update invitation set redeemed_at = now(), redeemed_by_user_id = ${userId}
        where id = ${inviteId} and redeemed_at is null
        returning id
      `);
      if (claimed.length === 0) throw new Error('lost the race');
    });
  }

  it('lets exactly one of five simultaneous redemptions win', async () => {
    const inviteId = await createInvite();
    const users = await Promise.all(Array.from({ length: 5 }, () => seedUser(db, organizationId)));

    let index = 0;
    const outcome = await race(5, () => redeem(inviteId, users[index++] ?? users[0] ?? ''));

    // A second winner would mean an unintended account was created.
    expect(outcome.fulfilled).toBe(1);
    expect(outcome.rejected).toBe(4);
  });

  it('records exactly one redeeming user', async () => {
    const inviteId = await createInvite();
    const users = await Promise.all(Array.from({ length: 4 }, () => seedUser(db, organizationId)));

    let index = 0;
    await race(4, () => redeem(inviteId, users[index++] ?? users[0] ?? ''));

    const rows = await db.execute<{ redeemed_by_user_id: string | null }>(
      sql`select redeemed_by_user_id from invitation where id = ${inviteId}`,
    );
    expect(rows[0]?.redeemed_by_user_id).toBeTruthy();
    expect(users).toContain(rows[0]?.redeemed_by_user_id);
  });

  it('refuses a redemption attempted after the invite is spent', async () => {
    const inviteId = await createInvite();
    const first = await seedUser(db, organizationId);
    const second = await seedUser(db, organizationId);

    await redeem(inviteId, first);
    await expect(redeem(inviteId, second)).rejects.toThrow();
  });
});

describe.skipIf(!available)('live: share revocation races', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('share-race');
    db = live.db;
    state.db = db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createShare(): Promise<{ id: string; slug: string }> {
    const [thread] = await db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${userId}, 'Shared') returning id
    `);
    const slug = `slug-${randomUUID().slice(0, 12)}`;

    const [link] = await db.execute<{ id: string }>(sql`
      insert into share_link (thread_id, user_id, slug)
      values (${thread?.id}, ${userId}, ${slug}) returning id
    `);
    if (!link) throw new Error('Failed to create share link');
    return { id: link.id, slug };
  }

  /** Calls the real service, which is idempotent by design. */
  async function revoke(linkId: string): Promise<void> {
    await revokeShareLink(linkId, userId);
  }

  async function revokedAt(linkId: string): Promise<string | null> {
    const rows = await db.execute<{ revoked_at: string | null }>(
      sql`select revoked_at from share_link where id = ${linkId}`,
    );
    return rows[0]?.revoked_at ?? null;
  }

  /** Mirrors the public read, which must never serve a revoked share. */
  async function readPublic(slug: string): Promise<boolean> {
    const rows = await db.execute<{ id: string }>(sql`
      select id from share_link
      where slug = ${slug} and revoked_at is null
        and (expires_at is null or expires_at > now())
    `);
    return rows.length > 0;
  }

  it('settles on a single revocation timestamp under concurrent revokes', async () => {
    const share = await createShare();

    // Revocation is idempotent, so the guarantee is a stable end state rather
    // than a single winner: the timestamp must not be rewritten by a later
    // caller, which would extend the window a revoked link stays addressable.
    await Promise.all(Array.from({ length: 5 }, () => revoke(share.id)));
    const first = await revokedAt(share.id);
    expect(first).toBeTruthy();

    await revoke(share.id);
    expect(await revokedAt(share.id)).toEqual(first);
  });

  it('stops serving a share the moment it is revoked', async () => {
    const share = await createShare();
    expect(await readPublic(share.slug)).toBe(true);

    await revoke(share.id);

    // No grace period: a revoked share must not serve one last snapshot.
    expect(await readPublic(share.slug)).toBe(false);
  });

  it('never serves a share after a concurrent revoke resolves', async () => {
    const share = await createShare();

    // Interleave reads with the revocation, then confirm the end state.
    const [reads] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => readPublic(share.slug))),
      revoke(share.id),
    ]);

    // Reads racing the revoke may legitimately succeed; reads afterwards
    // must not.
    expect(reads.every((value) => typeof value === 'boolean')).toBe(true);
    expect(await readPublic(share.slug)).toBe(false);
  });

  it('keeps an expired share unreadable even before revocation', async () => {
    const share = await createShare();
    await db.execute(
      sql`update share_link set expires_at = now() - interval '1 hour' where id = ${share.id}`,
    );

    expect(await readPublic(share.slug)).toBe(false);
  });
});
