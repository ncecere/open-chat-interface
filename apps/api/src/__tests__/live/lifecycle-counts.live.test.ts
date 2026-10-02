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
import { listBroadcasts } from '../../services/broadcasts.js';
import { listTrashedThreads } from '../../services/lifecycle/trash.js';
import { listPolicies } from '../../services/onboarding.js';

const state = vi.hoisted(() => ({ db: null as Database | null, organizationId: '' }));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));

const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: per-row counts in lifecycle lists', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('trash_list');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    state.organizationId = organizationId;
    userId = await seedUser(live.db, organizationId, { email: 'trash@example.test' });
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('counts the messages of each trashed conversation', async () => {
    const deletedAt = new Date();
    const [three, one, empty] = await live.db
      .insert(schema.thread)
      .values(
        [3, 1, 0].map((_, index) => ({
          organizationId,
          userId,
          title: `Trashed ${index}`,
          deletedAt: new Date(deletedAt.getTime() - index * 1000),
          deletedReason: 'user' as const,
        })),
      )
      .returning();
    await live.db.insert(schema.message).values(
      [
        ...[0, 1, 2].map((position) => ({ threadId: three!.id, position })),
        { threadId: one!.id, position: 0 },
      ].map(({ threadId, position }) => ({
        threadId,
        userId,
        role: 'user' as const,
        position,
        parts: [{ type: 'text', text: 'Synthetic trash fixture' }],
      })),
    );

    const trashed = await listTrashedThreads(userId);
    expect(trashed.map(({ id, messageCount }) => ({ id, messageCount }))).toEqual([
      { id: three!.id, messageCount: 3 },
      { id: one!.id, messageCount: 1 },
      { id: empty!.id, messageCount: 0 },
    ]);
  });

  it('counts the dismissals of each announcement', async () => {
    const readers = await Promise.all(
      [1, 2].map((index) =>
        seedUser(live.db, organizationId, { email: `reader-${index}@example.test` }),
      ),
    );
    const [twice, never] = await live.db
      .insert(schema.broadcast)
      .values(
        ['Dismissed twice', 'Never dismissed'].map((title, index) => ({
          organizationId,
          title,
          body: 'Synthetic announcement',
          createdAt: new Date(Date.now() - index * 1000),
        })),
      )
      .returning();
    await live.db
      .insert(schema.broadcastDismissal)
      .values(readers.map((reader) => ({ broadcastId: twice!.id, userId: reader })));

    const broadcasts = await listBroadcasts();
    expect(broadcasts.map(({ id, dismissalCount }) => ({ id, dismissalCount }))).toEqual([
      { id: twice!.id, dismissalCount: 2 },
      { id: never!.id, dismissalCount: 0 },
    ]);
  });

  it('counts the acceptances of each usage policy version', async () => {
    const readers = await Promise.all(
      [1, 2].map((index) =>
        seedUser(live.db, organizationId, { email: `policy-${index}@example.test` }),
      ),
    );
    const [current, previous] = await live.db
      .insert(schema.usagePolicy)
      .values(
        [2, 1].map((version) => ({
          organizationId,
          version,
          title: `Policy ${version}`,
          body: 'Synthetic policy',
          publishedAt: new Date(),
        })),
      )
      .returning();
    await live.db
      .insert(schema.usagePolicyAcceptance)
      .values([
        ...readers.map((reader) => ({ policyId: current!.id, userId: reader, policyVersion: 2 })),
        { policyId: previous!.id, userId: readers[0]!, policyVersion: 1 },
      ]);

    const policies = await listPolicies();
    expect(policies.map(({ id, acceptanceCount }) => ({ id, acceptanceCount }))).toEqual([
      { id: current!.id, acceptanceCount: 2 },
      { id: previous!.id, acceptanceCount: 1 },
    ]);
  });
});
