import type { Database } from '@oci/db';
import { schema } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { listQuerySchema, listUsers } from '../../services/admin-users/listing.js';

const state = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));

const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: administrative user counts', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let owner: string;
  let other: string;
  let empty: string;
  let otherThread: string;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_counts');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    owner = await seedUser(live.db, organizationId, { role: 'admin', email: 'owner@example.test' });
    other = await seedUser(live.db, organizationId, { email: 'other@example.test' });
    empty = await seedUser(live.db, organizationId, { email: 'empty@example.test' });
  });
  beforeEach(async () => {
    await live.db.delete(schema.message);
    await live.db.delete(schema.thread);
    const threads = await live.db
      .insert(schema.thread)
      .values([owner, owner, other].map((userId) => ({ organizationId, userId })))
      .returning();
    otherThread = threads[2]!.id;
    await live.db.insert(schema.message).values(
      threads.flatMap((thread, index) =>
        Array.from({ length: index < 2 ? 2 : 1 }, (_, position) => ({
          threadId: thread.id,
          userId: thread.userId,
          role: 'user' as const,
          position,
          parts: [{ type: 'text', text: 'Synthetic count fixture' }],
        })),
      ),
    );
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('returns each account’s actual thread and message counts', async () => {
    const result = await listUsers(listQuerySchema.parse({}));
    expect(result.total).toBe(3);
    expect(result.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: owner, threadCount: 2, messageCount: 4 }),
        expect.objectContaining({ id: other, threadCount: 1, messageCount: 1 }),
        expect.objectContaining({ id: empty, threadCount: 0, messageCount: 0 }),
      ]),
    );
  });

  it('keeps displayed counts consistent with sorting, filtering and pagination', async () => {
    const first = await listUsers(listQuerySchema.parse({ sort: 'threads', limit: 1 }));
    const second = await listUsers(listQuerySchema.parse({ sort: 'threads', limit: 1, offset: 1 }));
    const filtered = await listUsers(listQuerySchema.parse({ role: 'admin', sort: 'messages' }));
    expect(first.users[0]).toMatchObject({ id: owner, threadCount: 2, messageCount: 4 });
    expect(second.users[0]).toMatchObject({ id: other, threadCount: 1, messageCount: 1 });
    expect(filtered.total).toBe(1);
    expect(filtered.users[0]).toMatchObject({ id: owner, threadCount: 2, messageCount: 4 });
  });

  it('reports zero for an account without activity', async () => {
    const result = await listUsers(listQuerySchema.parse({ search: 'empty@example.test' }));
    expect(result.total).toBe(1);
    expect(result.users[0]).toMatchObject({ id: empty, threadCount: 0, messageCount: 0 });
  });

  it('does not confuse child identifiers with the outer account identifier', async () => {
    await live.db.insert(schema.thread).values({ id: owner, organizationId, userId: owner });
    await live.db.insert(schema.message).values({
      id: other,
      threadId: otherThread,
      userId: other,
      role: 'assistant',
      position: 2,
      parts: [{ type: 'text', text: 'Identifier collision fixture' }],
    });
    const result = await listUsers(listQuerySchema.parse({ search: 'empty@example.test' }));
    expect(result.users[0]).toMatchObject({ id: empty, threadCount: 0, messageCount: 0 });
  });
});
