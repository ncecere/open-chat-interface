import type { Database } from '@oci/db';
import { schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { listQuerySchema, listUsers } from '../../services/admin-users/listing.js';
import { listThreads } from '../../services/threads.js';

const state = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));

/** `%` and `_` typed into a search box are text, not LIKE wildcards. */
const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: search text is matched literally', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('literal_search');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, organizationId, { email: 'a_b@example.test' });
    await seedUser(live.db, organizationId, { email: 'axb@example.test' });
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('in conversation titles', async () => {
    await live.db.insert(schema.thread).values(
      ['50% done', '500 tasks', 'file_name', 'filename'].map((title) => ({
        organizationId,
        userId,
        title,
      })),
    );
    const titles = async (search: string) =>
      (await listThreads(userId, { search })).map((thread) => thread.title).sort();

    expect(await titles('50%')).toEqual(['50% done']);
    expect(await titles('e_n')).toEqual(['file_name']);
  });

  it('in the administrator user list', async () => {
    const result = await listUsers(listQuerySchema.parse({ search: 'a_b' }));
    expect(result.users.map((user) => user.email)).toEqual(['a_b@example.test']);
  });
});
