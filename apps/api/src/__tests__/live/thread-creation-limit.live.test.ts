import { randomUUID } from 'node:crypto';
import { createDatabase, schema, sql } from '@oci/db';
import { ERROR_CODES, type UserRole } from '@oci/shared';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Starting conversations is bounded on the server (v0.10.2).
 *
 * In v0.10.1 one send from the home page, driven by an automated browser,
 * created 16,389 empty "New Chat" conversations for one person in about 20
 * seconds. The client now starts one conversation per send; these prove the
 * server no longer depends on that: POST /api/threads is rate limited per
 * person (the role's chat allowance, counted in Redis), a person cannot pile
 * up more than ten unused conversations a minute (counted in PostgreSQL), and
 * unused ones are cleaned up after a day. Real PostgreSQL, Redis and route.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
/** Small for `user`, so the rate limit is reached quickly; large for `admin`. */
const USER_LIMIT = 5;
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
    }),
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'rateLimits')
      return {
        roles: {
          user: { chatRequestsPerMinute: 5 },
          admin: { chatRequestsPerMinute: 1000 },
        },
      };
    if (key === 'features') return { temporaryChat: true, branching: true, shareLinks: true };
    return {};
  },
}));

async function redisAvailable() {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = (await livePostgresAvailable()) && (await redisAvailable());

const DAY = 86_400_000;

describe.skipIf(!available)('live: starting conversations is bounded', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    live = await createLiveDatabase('thread_creation_limit');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function person(role: UserRole) {
    return seedUser(pool.db, state.organizationId, {
      role,
      email: `${randomUUID()}@example.test`,
    });
  }

  async function appFor(userId: string, role: UserRole) {
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        email: 'person@example.test',
        name: 'Person',
        image: null,
        role,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    return app;
  }

  function start(app: Hono<AppBindings>, body: Record<string, unknown> = {}) {
    return app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ temporary: false, ...body }),
    });
  }

  async function threadsOf(userId: string) {
    return pool.db
      .select({ id: schema.thread.id, title: schema.thread.title })
      .from(schema.thread)
      .where(sql`${schema.thread.userId} = ${userId}`);
  }

  async function addMessage(threadId: string, userId: string) {
    await pool.db.execute(sql`
      insert into message (thread_id, user_id, role, parts, status)
      values (${threadId}, ${userId}, 'user', '[{"type":"text","text":"hello"}]'::jsonb, 'complete')`);
  }

  it('limits how fast one person starts conversations, with Retry-After', async () => {
    // Early in a fixed window, so the burst cannot straddle two windows. Only
    // Date is faked: PostgreSQL and Redis keep real time.
    const now = new Date();
    now.setSeconds(5, 0);
    vi.useFakeTimers({ toFake: ['Date'], now });

    const [userId, otherId] = [await person('user'), await person('user')];
    const app = await appFor(userId, 'user');
    // Titled, so only the rate limit (not the unused backstop) can refuse.
    for (let index = 0; index < USER_LIMIT; index += 1) {
      const response = await start(app, { title: `Conversation ${index}` });
      expect(response.status, await response.text()).toBe(201);
    }

    const refused = await start(app, { title: 'One too many' });
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.error.message).toMatch(/starting conversations too quickly/);
    expect(await threadsOf(userId)).toHaveLength(USER_LIMIT);

    // Per person: someone else is unaffected.
    const other = await start(await appFor(otherId, 'user'));
    expect(other.status).toBe(201);

    // The next window starts afresh.
    vi.setSystemTime(new Date(now.getTime() + 60_000));
    expect((await start(app, { title: 'Next minute' })).status).toBe(201);
  });

  it('refuses more than ten unused conversations a minute, but never a used or titled one', async () => {
    const adminId = await person('admin');
    const app = await appFor(adminId, 'admin');
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await start(app);
      expect(response.status, await response.clone().text()).toBe(201);
      ids.push(((await response.json()) as { thread: { id: string } }).thread.id);
    }

    // The flood case: another untitled conversation while ten sit unused.
    const refused = await start(app);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.error.message).toMatch(/without sending anything/);
    // A temporary chat is a conversation too: the same count applies.
    expect((await start(app, { temporary: true })).status).toBe(429);
    expect(await threadsOf(adminId)).toHaveLength(10);

    // A titled conversation is not another unused "New Chat".
    expect((await start(app, { title: 'Imported notes' })).status).toBe(201);

    // Once one is used (its first message arrived), there is room again.
    await addMessage(ids[0]!, adminId);
    expect((await start(app)).status).toBe(201);
    expect((await start(app)).status).toBe(429);

    // Unused ones from more than a minute ago no longer count.
    await pool.db.execute(sql`
      update thread set created_at = now() - interval '2 minutes',
        updated_at = now() - interval '2 minutes'
      where user_id = ${adminId}`);
    expect((await start(app)).status).toBe(201);
    // Ten untitled, the titled one, and one after each release.
    expect(await threadsOf(adminId)).toHaveLength(13);
  });

  it('cleans up conversations that were started and never used, after a day', async () => {
    const { purgeUnusedThreads } = await import('../../services/threads.js');
    const userId = await person('user');
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    async function thread(
      label: string,
      fields: {
        title?: string;
        at?: string;
        pinned?: boolean;
        archived?: boolean;
        temporary?: boolean;
        deleted?: boolean;
        imported?: boolean;
      } = {},
    ) {
      const at = fields.at ?? old;
      const [row] = await pool.db.execute<{ id: string }>(sql`
        insert into thread (organization_id, user_id, title, pinned, archived, temporary,
          expires_at, deleted_at, deleted_reason, import_source, import_source_id,
          created_at, updated_at)
        values (${state.organizationId}, ${userId}, ${fields.title ?? 'New Chat'},
          ${fields.pinned ?? false}, ${fields.archived ?? false}, ${fields.temporary ?? false},
          ${fields.temporary ? sql`now() + interval '1 day'` : null},
          ${fields.deleted ? sql`now()` : null}, ${fields.deleted ? 'user' : null},
          ${fields.imported ? 'chatgpt' : null}, ${fields.imported ? label : null},
          ${at}::timestamptz, ${at}::timestamptz)
        returning id`);
      return row!.id;
    }

    const doomed = [await thread('unused'), await thread('also unused')];
    const kept = {
      recent: await thread('recent', { at: new Date().toISOString() }),
      titled: await thread('titled', { title: 'Shopping list' }),
      pinned: await thread('pinned', { pinned: true }),
      archived: await thread('archived', { archived: true }),
      temporary: await thread('temporary', { temporary: true }),
      trashed: await thread('trashed', { deleted: true }),
      imported: await thread('imported', { imported: true }),
      used: await thread('used'),
    };
    await addMessage(kept.used, userId);

    expect(await purgeUnusedThreads()).toBe(2);
    const left = new Set((await threadsOf(userId)).map((row) => row.id));
    for (const id of doomed) expect(left.has(id)).toBe(false);
    for (const [label, id] of Object.entries(kept))
      expect([label, left.has(id)]).toEqual([label, true]);

    // Recorded like every other deletion, without an actor.
    const events = await pool.db.execute<{ reason: string; actor: string | null }>(sql`
      select metadata->'deletion'->>'reason' as reason, actor_user_id as actor
      from audit_log
      where action = 'conversation.delete' and target_id in (${sql.join(
        doomed.map((id) => sql`${id}`),
        sql`, `,
      )})`);
    expect(events.map((event) => [event.reason, event.actor])).toEqual([
      ['unused_expiry', null],
      ['unused_expiry', null],
    ]);
    expect(await purgeUnusedThreads()).toBe(0);
  });

  // A conversation whose first message was refused (a server restarting) was
  // left in the person's history as an empty "New Chat" (#234). The page asks
  // for it to be removed when the person leaves it; only an unused one goes.
  it("removes an unused conversation at once on request, never a used or someone else's", async () => {
    const [userId, otherId] = [await person('admin'), await person('admin')];
    const app = await appFor(userId, 'admin');
    const startId = async () =>
      ((await (await start(app)).json()) as { thread: { id: string } }).thread.id;
    const remove = async (id: string, as = app) => {
      const response = await as.request(`/api/threads/${id}/unused`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      return ((await response.json()) as { removed: boolean }).removed;
    };
    const [unusedId, usedId] = [await startId(), await startId()];
    await addMessage(usedId, userId);

    // Someone else's: kept.
    expect(await remove(unusedId, await appFor(otherId, 'admin'))).toBe(false);
    expect(await remove(usedId)).toBe(false);
    expect(await remove(unusedId)).toBe(true);
    // Destroyed, not trashed: nothing to restore.
    expect((await threadsOf(userId)).map((thread) => thread.id)).toEqual([usedId]);
    expect(await remove(unusedId)).toBe(false);
  });
});
