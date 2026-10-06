import { randomUUID } from 'node:crypto';
import { createDatabase } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * Forgot password, resend verification and sign-in take as long for an
 * address with an account as for one without, however slow the mail server
 * is (#328). Forgot password awaited the SMTP send for an existing account
 * only, so it answered about 7× slower for one (about 10 s with the mail
 * server down). The requests go through Better Auth's real handler, the real
 * policy hooks and the real email module against a live database; only the
 * SMTP transport is a fake that takes MAIL_DELAY_MS to accept each message.
 */
const MAIL_DELAY_MS = 900;
/** Far below MAIL_DELAY_MS, far above the database's own jitter. */
const MAX_MEDIAN_GAP_MS = 150;
const ROUNDS = 5;

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  sent: [] as Array<{ to: string; subject: string }>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string }) => {
        await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY_MS));
        state.sent.push(mail);
        return { messageId: 'slow' };
      },
    }),
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Fix7 Timing' }));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'auth')
      return {
        registrationMode: 'open',
        localAuthEnabled: true,
        emailVerificationRequired: true,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    if (key === 'smtp')
      return {
        host: 'mail.example.test',
        port: 587,
        secure: false,
        fromAddress: 'oci@example.test',
        username: null,
        encryptedPassword: null,
      };
    return {};
  },
}));

const available = await livePostgresAvailable();
const password = 'Fix7-timing-password-1234';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe.skipIf(!available)('live: auth response times do not reveal accounts (#328)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];
  let existing: string;

  beforeAll(async () => {
    live = await createLiveDatabase('auth_email_timing');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    ({ auth } = await import('../../auth/index.js'));
    existing = `fix7-timing-${randomUUID().slice(0, 8)}@example.test`;
    // Unverified, so resend verification really sends to it.
    await auth.api.createUser({ body: { email: existing, password, name: 'Fix7 Timing' } });
  });
  beforeEach(() => {
    state.sent = [];
  });
  afterEach(async () => {
    // A send still in the fake server's hands would land in the next test.
    await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY_MS + 300));
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  async function timed(path: string, body: Record<string, unknown>) {
    const started = performance.now();
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify(body),
      }),
    );
    await response.text();
    return { ms: performance.now() - started, status: response.status };
  }

  /** Medians over interleaved requests, so drift affects both sides alike. */
  async function compare(path: string, body: (email: string) => Record<string, unknown>) {
    const withAccount: number[] = [];
    const without: number[] = [];
    // One untimed round first: the first request pays for module and pool warm-up.
    await timed(path, body(`fix7-warmup-${randomUUID()}@example.test`));
    for (let round = 0; round < ROUNDS; round++) {
      const a = await timed(path, body(existing));
      const b = await timed(path, body(`fix7-nobody-${randomUUID()}@example.test`));
      expect(a.status).toBe(b.status);
      withAccount.push(a.ms);
      without.push(b.ms);
    }
    return { withAccount: median(withAccount), without: median(without) };
  }

  it('answers Forgot password as fast for an existing account, and still sends its email', async () => {
    const { withAccount, without } = await compare('/request-password-reset', (email) => ({
      email,
      redirectTo: '/auth/reset-password',
    }));
    expect(Math.abs(withAccount - without)).toBeLessThan(MAX_MEDIAN_GAP_MS);
    expect(withAccount).toBeLessThan(MAIL_DELAY_MS);
    // The emails still go out, one per request for the existing account only.
    await vi.waitFor(() => expect(state.sent).toHaveLength(ROUNDS), {
      timeout: MAIL_DELAY_MS * (ROUNDS + 2),
    });
    expect(state.sent.every((mail) => mail.to === existing)).toBe(true);
  }, 30_000);

  it('answers resend verification in the same time either way, even with a slow mail server', async () => {
    const { withAccount, without } = await compare('/send-verification-email', (email) => ({
      email,
      callbackURL: '/',
    }));
    expect(Math.abs(withAccount - without)).toBeLessThan(MAX_MEDIAN_GAP_MS);
    await vi.waitFor(() => expect(state.sent.length).toBeGreaterThan(0), {
      timeout: MAIL_DELAY_MS * 3,
    });
    expect(state.sent.every((mail) => mail.to === existing)).toBe(true);
  }, 30_000);

  it('answers a wrong-password sign-in in the same time either way', async () => {
    const { withAccount, without } = await compare('/sign-in/email', (email) => ({
      email,
      password: 'Fix7-wrong-password-1234',
    }));
    expect(Math.abs(withAccount - without)).toBeLessThan(MAX_MEDIAN_GAP_MS);
    expect(state.sent).toHaveLength(0);
  }, 30_000);
});
