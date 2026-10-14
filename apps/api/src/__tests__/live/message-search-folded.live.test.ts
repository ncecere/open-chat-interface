import { sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The folded search vector of a message (#362, SPEC-accent-search.md):
 * `message.search_folded`, kept by a trigger so that every writer is covered,
 * the twelve code paths that update `parts` and replicas of the previous
 * release during a rolling upgrade. It is NULL when folding leaves the text
 * unchanged (the exact index already finds those words), and does no work on
 * an update that leaves `parts` as it was.
 */
const available = await livePostgresAvailable();
const text = (value: string) => ({ type: 'text', text: value });

describe.skipIf(!available)('live Postgres: message.search_folded', () => {
  let live: LiveDatabase;
  let threadId: string;
  let ownerId: string;
  let position = 0;

  async function insert(parts: unknown[]): Promise<string> {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${threadId}, ${ownerId}, 'assistant', ${JSON.stringify(parts)}::jsonb, ${position++})
      returning id
    `);
    return row!.id;
  }

  /** The stored vector as text, or null. */
  async function folded(id: string): Promise<string | null> {
    const [row] = await live.db.execute<{ vector: string | null }>(
      sql`select search_folded::text as vector from message where id = ${id}`,
    );
    return row!.vector;
  }

  async function matches(id: string, word: string): Promise<boolean> {
    const [row] = await live.db.execute<{ hit: boolean }>(sql`
      select coalesce(search_folded @@ to_tsquery('simple', ${`${word}:*`}), false) as hit
      from message where id = ${id}
    `);
    return row!.hit;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('message_search_folded');
    const organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, organizationId, { email: 'owner@example.com' });
    const [thread] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${ownerId}, 'Search folded') returning id
    `);
    threadId = thread!.id;
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('stores the folded words of a message that has accents, and finds them unaccented', async () => {
    const id = await insert([text('Visitez la bibliothèque municipale, très belle.')]);
    expect(await matches(id, 'bibliotheque')).toBe(true);
    expect(await matches(id, 'tres')).toBe(true);
    // Folded words only: the accented spelling is the exact index's.
    expect(await matches(id, 'bibliothèque')).toBe(false);
  });

  it('expands ß, æ and œ', async () => {
    const id = await insert([text('Die Straße, das Œuvre, Ærø')]);
    expect(await matches(id, 'strasse')).toBe(true);
    expect(await matches(id, 'oeuvre')).toBe(true);
    expect(await matches(id, 'aero')).toBe(true);
  });

  it('stays NULL when folding changes nothing, so the exact index serves it', async () => {
    expect(await folded(await insert([text('Plain English, nothing to fold.')]))).toBeNull();
    expect(await folded(await insert([text('日本語の宿題 Привет مرحبا')]))).toBeNull();
    expect(await folded(await insert([]))).toBeNull();
  });

  it('reads only the text parts, as the exact index does', async () => {
    expect(
      await folded(await insert([{ type: 'reasoning', text: 'réflexion' }, text('plain words')])),
    ).toBeNull();
    const id = await insert([{ type: 'reasoning', text: 'réflexion' }, text('énoncé')]);
    expect(await matches(id, 'enonce')).toBe(true);
    expect(await matches(id, 'reflexion')).toBe(false);
  });

  it('survives JSON escapes in the text', async () => {
    const id = await insert([text('première ligne\nseconde "citation" été\tfin')]);
    expect(await matches(id, 'premiere')).toBe(true);
    expect(await matches(id, 'ete')).toBe(true);
    expect(await matches(id, 'citation')).toBe(true);
  });

  it('follows the text when parts change', async () => {
    const id = await insert([text('plain')]);
    expect(await folded(id)).toBeNull();
    await live.db.execute(
      sql`update message set parts = ${JSON.stringify([text('à la carte')])}::jsonb where id = ${id}`,
    );
    expect(await matches(id, 'carte')).toBe(true);
    await live.db.execute(
      sql`update message set parts = ${JSON.stringify([text('plain again')])}::jsonb where id = ${id}`,
    );
    expect(await folded(id)).toBeNull();
  });

  it('does no work on an update that leaves parts as they were', async () => {
    const id = await insert([text('déjà vu')]);
    const before = await folded(id);
    expect(before).not.toBeNull();
    // A marker the trigger would overwrite if it recomputed.
    await live.db.execute(
      sql`update message set search_folded = to_tsvector('simple', 'marker') where id = ${id}`,
    );
    // Another column: the trigger does not fire.
    await live.db.execute(sql`update message set status = 'complete' where id = ${id}`);
    expect(await folded(id)).toBe("'marker':1");
    // The same parts written again: it fires and leaves the vector alone.
    await live.db.execute(
      sql`update message set parts = ${JSON.stringify([text('déjà vu')])}::jsonb where id = ${id}`,
    );
    expect(await folded(id)).toBe("'marker':1");
  });
});
