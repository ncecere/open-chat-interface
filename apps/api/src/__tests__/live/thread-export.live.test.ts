import { sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Conversation export through the real route.
 *
 * Ownership is the part worth proving here: an export returns an entire
 * conversation in one response, so a missing check would be a disclosure bug
 * rather than a cosmetic one.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({
    branching: true,
    shareLinks: true,
    temporaryChat: true,
    // Branding (v0.10): the export header names the instance.
    appName: 'Acme Research',
  }),
}));

import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { threadRoutes } from '../../routes/threads.js';

describe.skipIf(!available)('live Postgres: conversation export', () => {
  let live: LiveDatabase;
  let ownerId: string;
  let strangerId: string;
  let threadId: string;

  function appFor(userId: string) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        email: 'user@example.com',
        name: 'User',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    return app;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('thread_export');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    strangerId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });

    const [thread] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${state.organizationId}, ${ownerId}, 'Migration planning')
      returning id
    `);
    if (!thread) throw new Error('Failed to create thread');
    threadId = thread.id;

    await live.db.execute(sql`
      insert into message (thread_id, user_id, role, parts, position, model_slug)
      values
        (${threadId}, ${ownerId}, 'user',
         '[{"type":"text","text":"How should we migrate?"}]'::jsonb, 0, null),
        (${threadId}, ${ownerId}, 'assistant',
         '[{"type":"reasoning","text":"internal deliberation"},{"type":"text","text":"Start with the schema."}]'::jsonb,
         1, 'claude-sonnet-4-6')
    `);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  it('returns the conversation as a Markdown download', async () => {
    const response = await appFor(ownerId).request(`/api/threads/${threadId}/export`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain('migration-planning');

    const body = await response.text();
    expect(body).toContain('# Migration planning');
    expect(body).toContain('How should we migrate?');
    expect(body).toContain('Start with the schema.');
  });

  it('names the instance it was exported from', async () => {
    const body = await (await appFor(ownerId).request(`/api/threads/${threadId}/export`)).text();
    expect(body).toMatch(/^Exported from Acme Research on \d{4}-\d{2}-\d{2} · started /m);
  });

  it('attributes each answer to the model that produced it', async () => {
    const body = await (await appFor(ownerId).request(`/api/threads/${threadId}/export`)).text();
    expect(body).toContain('claude-sonnet-4-6');
  });

  it('omits reasoning, which is working rather than an answer', async () => {
    const body = await (await appFor(ownerId).request(`/api/threads/${threadId}/export`)).text();
    // Including it would read as though the assistant said something it never
    // actually presented.
    expect(body).not.toContain('internal deliberation');
  });

  it('refuses to export a conversation belonging to someone else', async () => {
    const response = await appFor(strangerId).request(`/api/threads/${threadId}/export`);
    expect(response.status).toBe(404);
  });

  it('refuses to export a conversation that is in the trash', async () => {
    await live.db.execute(sql`update thread set deleted_at = now() where id = ${threadId}`);

    const response = await appFor(ownerId).request(`/api/threads/${threadId}/export`);
    expect(response.status).toBe(404);

    await live.db.execute(sql`update thread set deleted_at = null where id = ${threadId}`);
  });
});
