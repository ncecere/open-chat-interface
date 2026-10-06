import { schema, sql } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outageProxy } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Stop pressed while the database cannot be reached (#351), through the API's
 * real pipeline (app.ts, the session lookup, the read retry around it in
 * server.ts), the real chat route and a real Redis, with PostgreSQL behind a
 * TCP proxy that is cut as a stopped PostgreSQL would be.
 *
 * Before, the route read the thread in PostgreSQL before signalling the
 * producer, so Stop failed (a retryable 500 the page swallowed) although the
 * producer was alive and reachable through Redis, and the reply ran to the end.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};
async function redisAvailable() {
  const probe = new Redis(redisUrl, redisOptions);
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
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';

describe.skipIf(!available)('live: Stop while the database is away', { timeout: 90_000 }, () => {
  let live: LiveDatabase;
  let proxy: Awaited<ReturnType<typeof outageProxy>>;
  let fetchHandler: (request: Request) => Promise<Response>;
  let routeOnly: Hono<AppBindings>;
  let streams: typeof import('../../services/chat-streams.js');
  const redis = new Redis(redisUrl, redisOptions);
  const owner = { email: 'fix8-stop-owner@example.com', cookie: '', id: '' };
  const other = { email: 'fix8-stop-other@example.com', cookie: '', id: '' };
  const keys: string[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('chat_stop_outage');
    proxy = await outageProxy(live.connectionString);
    // The application pool (db/index.ts) and the stream store read these
    // when first imported.
    process.env.DATABASE_URL = proxy.url;
    process.env.REDIS_URL = redisUrl;
    await redis.connect();
    const { createApp } = await import('../../app.js');
    const { withReadRetry } = await import('../../middleware/read-retry.js');
    const { auth } = await import('../../auth/index.js');
    const settings = await import('../../services/settings.js');
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    streams = await import('../../services/chat-streams.js');
    expect(await streams.sharedRedis()).not.toBeNull();
    await settings.updateSetting('auth', {
      registrationMode: 'open',
      emailVerificationRequired: false,
      localAuthEnabled: true,
    });
    for (const person of [owner, other]) {
      await auth.api.signUpEmail({
        body: { email: person.email, password: PASSWORD, name: 'Fix8 Stop' },
      });
    }
    await live.db.execute(sql`update "user" set email_verified = true`);
    const app = createApp();
    fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));
    for (const person of [owner, other]) {
      const signedIn = await fetchHandler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ email: person.email, password: PASSWORD }),
        }),
      );
      expect(signedIn.status).toBe(200);
      person.cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
    }
    const users = await live.db
      .select({ id: schema.user.id, email: schema.user.email })
      .from(schema.user);
    owner.id = users.find((user) => user.email === owner.email)!.id;
    other.id = users.find((user) => user.email === other.email)!.id;

    // The chat route alone, with the person already known: what Stop does
    // once the session is resolved, without any session lookup.
    routeOnly = new Hono<AppBindings>();
    routeOnly.onError(errorHandler);
    routeOnly.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? owner.id,
        name: 'Fix8 Stop',
        email: owner.email,
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: '',
      });
      await next();
    });
    routeOnly.route('/api/chat', chatRoutes);
  });
  afterAll(async () => {
    if (keys.length) await redis.del(...keys);
    await proxy?.close();
    redis.disconnect();
    await streams?.closeChatStreams();
    await live?.destroy();
  });

  const call = (
    handler: (request: Request) => Response | Promise<Response>,
    threadId: string,
    cookie: string,
    headers: Record<string, string> = {},
  ) =>
    Promise.resolve(
      handler(
        new Request(`${ORIGIN}/api/chat/${threadId}/stream`, {
          method: 'DELETE',
          headers: { origin: ORIGIN, cookie, ...headers },
        }),
      ),
    );
  const stop = (threadId: string, person = owner) => call(fetchHandler, threadId, person.cookie);

  /** An owner's thread with a reply running somewhere else (a producer reachable only through Redis). */
  async function runningReply() {
    const created = await fetchHandler(
      new Request(`${ORIGIN}/api/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: owner.cookie },
        body: JSON.stringify({ title: 'Fix8 stop during an outage' }),
      }),
    );
    expect(created.status).toBe(201);
    const threadId = ((await created.json()) as { thread: { id: string } }).thread.id;
    const identity = { runId: crypto.randomUUID(), threadId, userId: owner.id };
    expect(await streams.beginChatRun(identity)).toBe('available');
    keys.push(
      `oci:chat-stream:run:${identity.runId}:metadata`,
      `oci:chat-stream:run:${identity.runId}:events`,
      `oci:chat-stream:thread:${threadId}:active`,
    );
    return identity;
  }

  it('signals the producer without reading the database once the person is known', async () => {
    const identity = await runningReply();
    await proxy.cut();
    try {
      const started = Date.now();
      // Before: the thread lookup failed, a retryable 500, and nothing was signalled.
      const response = await call(routeOnly.fetch.bind(routeOnly), identity.threadId, '');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cancelled: true });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await proxy.restore();
    }
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(true);
  });

  it('does not let anyone else stop the run, with the database away or not', async () => {
    const identity = await runningReply();
    // Their own request, signed in as somebody else, database up: not theirs.
    const refused = await stop(identity.threadId, other);
    expect(refused.status).toBe(404);
    // The route alone, as somebody else, database away: the run's record in
    // Redis names its owner, so nothing is signalled and the thread is not
    // read for them either.
    await proxy.cut();
    try {
      const response = await call(routeOnly.fetch.bind(routeOnly), identity.threadId, '', {
        'x-test-user': other.id,
      });
      expect(response.status).toBe(500);
      expect(await response.json()).not.toEqual({ cancelled: true });
    } finally {
      await proxy.restore();
    }
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(false);
    // The owner's own Stop still works afterwards.
    const owned = await stop(identity.threadId);
    expect(owned.status).toBe(200);
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(true);
  });

  it('waits out a short outage in the session lookup, then stops the reply', async () => {
    const identity = await runningReply();
    await proxy.cut();
    const started = Date.now();
    const stopping = stop(identity.threadId);
    const restored = new Promise((resolve) =>
      setTimeout(() => void proxy.restore().then(resolve), 3_000),
    );
    try {
      const response = await stopping;
      // Before: a retryable 500 within milliseconds, and the reply ran on.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cancelled: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    } finally {
      await restored;
    }
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(true);
  });

  it('gives up within about 10 s of a longer outage with a retryable answer, and stops once it ends', async () => {
    const identity = await runningReply();
    await proxy.cut();
    const started = Date.now();
    try {
      const response = await stop(identity.threadId);
      const waited = Date.now() - started;
      expect(response.status).toBe(500);
      expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(13_000);
    } finally {
      await proxy.restore();
    }
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(false);
    // The page sends it again (with a pause between); it goes through.
    const again = await stop(identity.threadId);
    expect(again.status).toBe(200);
    expect(await streams.isChatRunCancellationRequested(identity.runId)).toBe(true);
  });

  it('keeps answering "nothing to stop" for a thread of the person with no run', async () => {
    const created = await fetchHandler(
      new Request(`${ORIGIN}/api/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: owner.cookie },
        body: JSON.stringify({ title: 'Fix8 nothing running' }),
      }),
    );
    const threadId = ((await created.json()) as { thread: { id: string } }).thread.id;
    const response = await stop(threadId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false });
  });
});
