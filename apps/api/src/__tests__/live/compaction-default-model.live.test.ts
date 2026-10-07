import { sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * "Summarise earlier messages now" without a named model (#363): the latest
 * reply's model, but never one whose reply just failed. Real PostgreSQL and
 * the real model catalog.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { schema } = await import('@oci/db');
const { defaultSummaryModel } = await import('../../services/chat/compaction-records.js');

describe.skipIf(!available)('live: the model a summary uses when none is named', () => {
  let live: LiveDatabase;
  let userId: string;
  let position = 0;

  async function thread() {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${state.organizationId}, ${userId}, 'Fix9 summary model') returning id
    `);
    position = 0;
    return row!.id;
  }

  async function reply(threadId: string, modelSlug: string, status: 'complete' | 'error') {
    position += 1;
    await live.db.execute(sql`
      insert into message (thread_id, user_id, role, parts, position, model_slug, status)
      values (${threadId}, ${userId}, 'assistant', '[]'::jsonb, ${position}, ${modelSlug}, ${status})
    `);
  }

  async function addModel(slug: string, options: { isDefault?: boolean; enabled?: boolean } = {}) {
    const [provider] = await live.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai-compatible',
        label: `Fix9 ${slug}`,
        baseUrl: 'http://127.0.0.1:9/v1',
      })
      .returning();
    await live.db.insert(schema.model).values({
      organizationId: state.organizationId,
      providerId: provider!.id,
      slug,
      upstreamModelId: slug,
      displayName: slug,
      visibleToRoles: ['user'],
      isDefault: options.isDefault ?? false,
      enabled: options.enabled ?? true,
    });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('compaction_default_model');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, state.organizationId, { email: 'summary@example.com' });
    await addModel('alpha');
    await addModel('beta', { isDefault: true });
    await addModel('gamma');
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('is the model of the latest reply when it worked, and null with no reply', async () => {
    const id = await thread();
    expect(await defaultSummaryModel(id, userId, 'user')).toBeNull();
    await reply(id, 'alpha', 'complete');
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('alpha');
  });

  it('is the instance default when the latest reply failed', async () => {
    const id = await thread();
    await reply(id, 'alpha', 'complete');
    await reply(id, 'gamma', 'error');
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('beta');
  });

  it('is the person’s own default first, if it can be used', async () => {
    await live.db.execute(sql`
      insert into user_preference (user_id, default_model_slug) values (${userId}, 'alpha')
    `);
    const id = await thread();
    await reply(id, 'gamma', 'error');
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('alpha');
    // A default that is the failed model, or no longer exists, is skipped.
    await reply(id, 'alpha', 'error');
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('beta');
    await live.db.execute(sql`update user_preference set default_model_slug = 'gone'`);
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('beta');
  });

  it('keeps the failed model when it is the only one there is', async () => {
    const id = await thread();
    await live.db.execute(sql`update model set enabled = false where slug <> 'gamma'`);
    await reply(id, 'gamma', 'error');
    expect(await defaultSummaryModel(id, userId, 'user')).toBe('gamma');
  });
});
