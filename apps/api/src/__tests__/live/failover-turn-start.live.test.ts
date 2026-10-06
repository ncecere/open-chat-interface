import { eq, schema, sql } from '@oci/db';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outageProxy } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * A new message sent while the database cannot be reached (#326), through the
 * API's real pipeline (app.ts, the session lookup, the read retry around it in
 * server.ts), real settings, the real chat route and PostgreSQL behind a TCP
 * proxy that is cut as a stopped PostgreSQL would be. Only the model is
 * replaced.
 *
 * docs/OPERATIONS.md: "A new message whose saving meets the failover is
 * retried for up to 10 s". Before, a message sent while the database was away
 * answered a retryable 500 within milliseconds (its session lookup failed
 * first), even when the database was back two seconds later, and the browser
 * showed it as sent though nothing was stored.
 */
const state = vi.hoisted(() => ({ model: null as unknown }));
vi.mock('../../services/models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/models.js')>()),
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));

const available = await livePostgresAvailable();
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';

function replyingModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: text });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({
              type: 'finish',
              usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
              finishReason: { unified: 'stop', raw: 'stop' },
            });
            controller.close();
          },
        }),
      }) as never,
  });
}

describe.skipIf(!available)(
  'live: a new message sent while the database is away',
  { timeout: 90_000 },
  () => {
    let live: LiveDatabase;
    let proxy: Awaited<ReturnType<typeof outageProxy>>;
    let fetchHandler: (request: Request) => Promise<Response>;
    let cookie = '';
    let userId = '';
    const email = 'fix7-turn-outage@example.com';

    beforeAll(async () => {
      live = await createLiveDatabase('turn_outage');
      proxy = await outageProxy(live.connectionString);
      // The application pool (db/index.ts) connects through the proxy; set
      // before anything reads the environment.
      process.env.DATABASE_URL = proxy.url;
      const { createApp } = await import('../../app.js');
      const { withReadRetry } = await import('../../middleware/read-retry.js');
      const { auth } = await import('../../auth/index.js');
      const settings = await import('../../services/settings.js');
      await settings.updateSetting('auth', {
        registrationMode: 'open',
        emailVerificationRequired: false,
        localAuthEnabled: true,
      });
      await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Fix7 Outage' } });
      await live.db.execute(sql`update "user" set email_verified = true`);
      const app = createApp();
      fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));
      const signedIn = await post('/api/auth/sign-in/email', { email, password: PASSWORD });
      expect(signedIn.status).toBe(200);
      cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const [user] = await live.db.select({ id: schema.user.id }).from(schema.user);
      userId = user!.id;
    });
    afterAll(async () => {
      await proxy?.close();
      await live?.destroy();
    });

    function post(path: string, body: Record<string, unknown>) {
      return fetchHandler(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
          body: JSON.stringify(body),
        }),
      );
    }
    async function newThread(title: string) {
      const response = await post('/api/threads', { title });
      expect(response.status).toBe(201);
      return ((await response.json()) as { thread: { id: string } }).thread.id;
    }
    const send = (threadId: string, text: string) =>
      post('/api/chat', {
        threadId,
        modelSlug: 'test-model',
        trigger: 'submit-message',
        messages: [{ id: 'client-id', role: 'user', parts: [{ type: 'text', text }] }],
      });
    const stored = (threadId: string) =>
      live.db
        .select({ role: schema.message.role, status: schema.message.status })
        .from(schema.message)
        .where(eq(schema.message.threadId, threadId));

    it('waits for a database that comes back within seconds, and stores the message once', async () => {
      const threadId = await newThread('Fix7 sent during an outage');
      state.model = replyingModel('Stored after the outage');
      await proxy.cut();
      const started = Date.now();
      const sending = send(threadId, 'Sent while the database is away');
      const restored = new Promise((resolve) =>
        setTimeout(() => void proxy.restore().then(resolve), 3_000),
      );
      try {
        const response = await sending;
        // Before: 500 retryable within milliseconds, and nothing stored.
        expect(response.status).toBe(200);
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
        expect(await response.text()).toContain('Stored after the outage');
      } finally {
        await restored;
      }
      await vi.waitFor(
        async () => {
          const rows = await stored(threadId);
          expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
          expect(rows.filter((row) => row.role === 'assistant')).toEqual([
            { role: 'assistant', status: 'complete' },
          ]);
        },
        { timeout: 10_000, interval: 100 },
      );
    });

    it('gives up within about 10 s, saying the message was not sent', async () => {
      const threadId = await newThread('Fix7 sent during a long outage');
      state.model = replyingModel('Never');
      await proxy.cut();
      const started = Date.now();
      try {
        const response = await send(threadId, 'Sent while the database stays away');
        const waited = Date.now() - started;
        expect(response.status).toBe(500);
        expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
        // Nothing of it can have been stored: the browser puts the text back.
        expect(response.headers.get('x-oci-message-saved')).toBe('no');
        expect(await response.json()).toEqual({
          error: {
            code: 'INTERNAL_ERROR',
            message:
              'The connection to the database was interrupted, so your message was not sent. Send it again in a moment.',
            retryable: true,
          },
        });
        expect(waited).toBeGreaterThanOrEqual(9_000);
        expect(waited).toBeLessThan(13_000);
      } finally {
        await proxy.restore();
      }
      expect(await stored(threadId)).toEqual([]);
    });

    it('does not claim a conversation or reserve usage twice when a commit’s answer was lost', async () => {
      // What a retry meets when its earlier attempt committed just as the
      // connection dropped: the run's own claim and reservation, by its ID.
      const threadId = await newThread('Fix7 claimed twice');
      const { claimThread } = await import('../../services/chat/thread-claim.js');
      const { reserveQuotaForRun } = await import('../../services/quota/index.js');
      const [thread] = await live.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, threadId));
      const context = {
        user: { id: userId, name: 'Fix7 Outage', role: 'user' as const },
        input: {
          threadId,
          modelSlug: 'test-model',
          webSearch: false,
          messages: [{ id: 'c', role: 'user' as const, parts: [{ type: 'text', text: 'x' }] }],
        },
        thread: thread!,
        resolved: { slug: 'test-model' },
        tools: { definitions: [] },
      } as unknown as Parameters<typeof claimThread>[0];
      const runId = crypto.randomUUID();
      expect(await claimThread(context, runId)).toEqual({ id: runId });
      // Before: 409 "A response is already being generated for this thread".
      expect(await claimThread(context, runId)).toEqual({ id: runId });
      const reserve = () =>
        reserveQuotaForRun({ userId, role: 'user', modelSlug: 'test-model', runId });
      expect((await reserve()).id).toBe(runId);
      // Before: a duplicate key error.
      expect((await reserve()).id).toBe(runId);
      expect(await stored(threadId)).toEqual([{ role: 'assistant', status: 'streaming' }]);
      const events = await live.db
        .select({ id: schema.usageEvent.id })
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, runId));
      expect(events).toHaveLength(1);
    });
  },
);
