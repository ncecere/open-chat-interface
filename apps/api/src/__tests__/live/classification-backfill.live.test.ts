import {
  createDatabase,
  scheduleBackgroundMigrations,
  THREAD_CONNECTOR_USE,
  threadConnectorUse,
} from '@oci/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The background migration `0.14.thread-connector-use` (#395) against real
 * PostgreSQL: it finds, in stored messages, the connector tools a conversation
 * used before 0.14 (or on a v0.13 replica in the upgrade window), in batches,
 * resumably, twice over, without disturbing a use recorded live; the resolver's
 * fallback scan finds the same connectors before it has run, and the mode is
 * refused until it is scheduled.
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
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => '',
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({ mode: 'block' }),
}));

const { runBackgroundMigrations } = await import('../../services/migrations/background-runner.js');
const { loadClasses } = await import('../../services/classification/resolve.js');
const { resetReadinessCache } = await import('../../services/migrations/readiness.js');

const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: thread_connector_use backfill', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  let organizationId: string;
  let ownerId: string;
  let position = 0;

  async function connector(slug: string, name = slug) {
    const [row] = await client<{ id: string }[]>`
      insert into connector (organization_id, name, slug, url)
      values (${organizationId}, ${name}, ${slug}, 'https://mcp.example.test') returning id`;
    return row!.id;
  }
  async function thread() {
    const [row] = await client<{ id: string }[]>`
      insert into thread (organization_id, user_id, title)
      values (${organizationId}, ${ownerId}, 'Backfill') returning id`;
    return row!.id;
  }
  async function message(threadId: string, parts: unknown[], role = 'assistant') {
    await client`insert into message (thread_id, user_id, role, parts, position)
      values (${threadId}, ${ownerId}, ${role}, ${JSON.stringify(parts)}::jsonb, ${position++})`;
  }
  const uses = async () =>
    client<{ thread_id: string; slug: string; first_used_at: Date }[]>`
      select u.thread_id, c.slug, u.first_used_at from thread_connector_use u
      join connector c on c.id = u.connector_id order by u.thread_id, c.slug`;
  const run = async () => {
    await client`update background_migration set batch_size = 7, pause_ms = 0`;
    await runBackgroundMigrations({
      client,
      definitions: [threadConnectorUse],
      throttle: async () => null,
      shouldStop: () => false,
    });
  };

  beforeAll(async () => {
    live = await createLiveDatabase('thread_connector_use_backfill');
    const app = createDatabase(live.connectionString, { max: 4 });
    client = app.sql;
    state.db = app.db;
    state.sql = client;
    organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, organizationId, { email: 'owner@example.com' });
  });
  beforeEach(async () => {
    await client`delete from thread`;
    await client`delete from connector`;
    await client`delete from background_migration`;
    resetReadinessCache();
  });
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  it('finds every connector a conversation used, in batches, and ignores everything else', async () => {
    const docs = await connector('docs');
    await connector('crm');
    await connector('unused');
    const first = await thread();
    const second = await thread();
    const third = await thread();
    // Padding so the scan takes several batches.
    for (let index = 0; index < 20; index += 1)
      await message(third, [{ type: 'text', text: 'hi' }]);
    await message(first, [
      { type: 'text', text: 'Searching' },
      { type: 'tool-mcp__docs__search', toolCallId: 'c1', state: 'output-available' },
      { type: 'tool-mcp__docs__create_page', toolCallId: 'c2', state: 'output-available' },
    ]);
    await message(first, [
      { type: 'dynamic-tool', toolName: 'mcp__crm__lookup', toolCallId: 'c3' },
    ]);
    // Built-in tools, a connector that does not exist, text that mentions a tool, a
    // user message and a part with no type are not uses.
    await message(second, [
      { type: 'tool-web_search', toolCallId: 'c4' },
      { type: 'dynamic-tool', toolName: 'web_search', toolCallId: 'c5' },
      { type: 'tool-mcp__gone__search', toolCallId: 'c6' },
      { type: 'text', text: 'tool-mcp__docs__search' },
      { toolCallId: 'c7' },
    ]);
    await message(second, [{ type: 'tool-mcp__docs__search', toolCallId: 'c8' }], 'user');
    await message(third, [{ type: 'tool-mcp__docs__search', toolCallId: 'c9' }]);
    // A message whose parts are not a list at all (nothing writes one) is skipped, not fatal.
    await client`insert into message (thread_id, user_id, role, parts, position)
      values (${second}, ${ownerId}, 'assistant', '{}'::jsonb, ${position++})`;

    expect(await scheduleBackgroundMigrations(client, [threadConnectorUse])).toEqual([
      THREAD_CONNECTOR_USE,
    ]);
    // A batch run twice (a lost commit) changes nothing.
    await client.begin((tx) => threadConnectorUse.batch(tx, { cursor: null, batchSize: 7 }));
    await client.begin((tx) => threadConnectorUse.batch(tx, { cursor: null, batchSize: 7 }));
    await run();

    const [migration] = await client<{ status: string }[]>`
      select status from background_migration where name = ${THREAD_CONNECTOR_USE}`;
    expect(migration?.status).toBe('finished');
    expect((await uses()).map((row) => [row.thread_id, row.slug])).toEqual(
      [
        [first, 'crm'],
        [first, 'docs'],
        [third, 'docs'],
      ].sort(),
    );
    expect(docs).toBeTruthy();
  });

  it('keeps a use recorded live, and the first time a conversation used it', async () => {
    const docs = await connector('docs');
    const chat = await thread();
    await message(chat, [{ type: 'tool-mcp__docs__search', toolCallId: 'c1' }]);
    await client`update message set created_at = '2025-01-02T03:04:05Z'`;
    await client`insert into thread_connector_use (thread_id, connector_id, first_used_at)
      values (${chat}, ${docs}, '2026-09-01T00:00:00Z')`;
    await scheduleBackgroundMigrations(client, [threadConnectorUse]);
    await run();
    const rows = await uses();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.first_used_at).toISOString()).toBe('2026-09-01T00:00:00.000Z');

    // And without a live row, the time of the earliest message that used it.
    await client`delete from thread_connector_use`;
    await client`delete from background_migration`;
    await scheduleBackgroundMigrations(client, [threadConnectorUse]);
    await run();
    expect(new Date((await uses())[0]!.first_used_at).toISOString()).toBe(
      '2025-01-02T03:04:05.000Z',
    );
  });

  it('finishes at once on an instance with no messages', async () => {
    await scheduleBackgroundMigrations(client, [threadConnectorUse]);
    await run();
    const [migration] = await client<{ status: string }[]>`
      select status from background_migration where name = ${THREAD_CONNECTOR_USE}`;
    expect(migration?.status).toBe('finished');
    expect(await uses()).toEqual([]);
  });

  it('is found by the resolver’s scan before it has run, and by the rows after', async () => {
    const student = (
      await client<{ id: string }[]>`
        insert into data_class (organization_id, name) values (${organizationId}, 'Student') returning id`
    )[0]!.id;
    const docs = await connector('docs');
    await client`insert into connector_data_class (connector_id, data_class_id) values (${docs}, ${student})`;
    const chat = await thread();
    await message(chat, [{ type: 'tool-mcp__docs__search', toolCallId: 'c1' }]);

    const before = await loadClasses({ threadId: chat });
    expect(before.map((entry) => entry.name)).toEqual(['Student']);
    expect(await uses()).toEqual([]);

    await scheduleBackgroundMigrations(client, [threadConnectorUse]);
    await run();
    resetReadinessCache();
    const after = await loadClasses({ threadId: chat });
    expect(after.map((entry) => [entry.name, entry.connectorNames])).toEqual([
      ['Student', ['docs']],
    ]);
    expect(await uses()).toHaveLength(1);
  });
});
