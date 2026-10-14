import {
  createDatabase,
  MESSAGE_SEARCH_FOLDED,
  messageSearchFolded,
  scheduleBackgroundMigrations,
} from '@oci/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The background migration `0.13.message-search-folded` (#362,
 * SPEC-accent-search.md) against real PostgreSQL: it fills the folded vector
 * of messages written before migration 0048, resumes from a cursor, can be
 * run twice, finds the same words as the trigger does for new messages, and
 * leaves every other column (the change sequence included) alone.
 */
const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));

const { runBackgroundMigrations } = await import('../../services/migrations/background-runner.js');

const available = await livePostgresAvailable();
const text = (value: string) => ({ type: 'text', text: value });

describe.skipIf(!available)('live Postgres: message.search_folded backfill', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  let threadId: string;
  let ownerId: string;
  let position = 0;

  async function insert(parts: unknown[]): Promise<string> {
    const [row] = await client<{ id: string }[]>`
      insert into message (thread_id, user_id, role, parts, position)
      values (${threadId}, ${ownerId}, 'assistant', ${JSON.stringify(parts)}::jsonb, ${position++})
      returning id`;
    return row!.id;
  }

  const vector = async (id: string) =>
    (
      await client<
        { v: string | null }[]
      >`select search_folded::text as v from message where id = ${id}`
    )[0]!.v;

  beforeAll(async () => {
    live = await createLiveDatabase('message_search_folded_backfill');
    const app = createDatabase(live.connectionString, { max: 4 });
    client = app.sql;
    state.db = app.db;
    state.sql = client;
    const organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, organizationId, { email: 'owner@example.com' });
    const [thread] = await client<{ id: string }[]>`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${ownerId}, 'Backfill') returning id`;
    threadId = thread!.id;
  });
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  it('fills old messages in batches, skips the rest, and can run twice', async () => {
    const accented = [] as string[];
    const plain = [] as string[];
    for (let i = 0; i < 60; i++) {
      accented.push(await insert([text(`Visitez la bibliothèque numéro ${i}, très belle`)]));
      plain.push(await insert([text(`Plain text number ${i}`)]));
    }
    const strasse = await insert([text('Die Straße und das Œuvre')]);
    // As if written before 0048: the trigger had not run.
    await client`update message set search_folded = null`;
    const [sequenceBefore] = await client<{ seq: string }[]>`
      select coalesce(sum(change_seq), 0)::text as seq from message`;

    expect(await scheduleBackgroundMigrations(client, [messageSearchFolded])).toEqual([
      MESSAGE_SEARCH_FOLDED,
    ]);
    await client`update background_migration set batch_size = 25, pause_ms = 0`;
    // A batch run twice (a lost commit) changes nothing.
    await client.begin((tx) => messageSearchFolded.batch(tx, { cursor: null, batchSize: 25 }));
    await client.begin((tx) => messageSearchFolded.batch(tx, { cursor: null, batchSize: 25 }));
    await runBackgroundMigrations({
      client,
      definitions: [messageSearchFolded],
      throttle: async () => null,
      shouldStop: () => false,
    });

    const [migration] = await client<{ status: string }[]>`
      select status from background_migration where name = ${MESSAGE_SEARCH_FOLDED}`;
    expect(migration?.status).toBe('finished');
    for (const id of accented) expect(await vector(id)).not.toBeNull();
    for (const id of plain) expect(await vector(id)).toBeNull();
    const [hit] = await client<{ n: number }[]>`
      select count(*)::int as n from message
      where search_folded @@ to_tsquery('simple', 'bibliotheque') and id = any(${accented})`;
    expect(hit!.n).toBe(60);
    const [ss] = await client<{ hit: boolean }[]>`
      select search_folded @@ to_tsquery('simple', 'strasse & oeuvre') as hit from message where id = ${strasse}`;
    expect(ss!.hit).toBe(true);

    // Nothing else changed: the compliance export sees no change.
    const [after] = await client<{ seq: string }[]>`
      select coalesce(sum(change_seq), 0)::text as seq from message`;
    expect(after!.seq).toBe(sequenceBefore!.seq);
  });

  it('gives an old message the same vector the trigger gives a new one', async () => {
    const parts = [text('Ça coûte très cher à Zürich, Ærø et Ño')];
    const viaTrigger = await insert(parts);
    const old = await insert(parts);
    await client`update message set search_folded = null where id = ${old}`;
    await client.begin((tx) => messageSearchFolded.batch(tx, { cursor: null, batchSize: 100_000 }));
    expect(await vector(old)).toBe(await vector(viaTrigger));
    expect(await vector(old)).not.toBeNull();
  });

  it('resumes from its cursor and reports when it is done', async () => {
    const result = await client.begin((tx) =>
      messageSearchFolded.batch(tx, {
        cursor: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        batchSize: 10,
      }),
    );
    expect(result).toEqual({
      cursor: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      rows: 0,
      done: true,
    });
  });
});
