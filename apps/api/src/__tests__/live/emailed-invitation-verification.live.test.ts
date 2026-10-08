import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * An invitation that was emailed to an address verifies it when accepted for
 * that address (#214). Real route, real Better Auth, real email service and
 * real PostgreSQL; only the SMTP transport is replaced, and it records every
 * message so the tests can see which mail was and was not sent.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  smtpConfigured: true,
  deliveryFails: false,
  mail: [] as Array<{ to: string; subject: string; text: string }>,
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
  getSetting: async (key: string) => {
    if (key === 'auth') {
      return {
        registrationMode: 'invite_only',
        localAuthEnabled: true,
        emailVerificationRequired: true,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    }
    if (key === 'smtp') {
      return {
        host: state.smtpConfigured ? 'smtp.invalid' : null,
        port: 25,
        fromAddress: 'no-reply@example.test',
        secure: false,
        username: null,
        encryptedPassword: null,
      };
    }
    return { appName: 'Invite test' };
  },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string; text: string }) => {
        if (state.deliveryFails) throw new Error('Injected SMTP rejection');
        state.mail.push(mail);
      },
    }),
  },
}));

const available = await livePostgresAvailable();
const password = 'Test-only-Invitation-123!';

describe.skipIf(!available)('live: an emailed invitation verifies the address (#214)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let acceptInvitation: typeof import('../../services/invitations.js')['acceptInvitation'];
  let counter = 0;

  beforeAll(async () => {
    live = await createLiveDatabase('emailed_invites');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const actor = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    const { inviteRoutes } = await import('../../routes/admin/invites.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    ({ acceptInvitation } = await import('../../services/invitations.js'));
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Invites admin',
        email: 'invites-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/invites', inviteRoutes);
  });
  beforeEach(() => {
    state.smtpConfigured = true;
    state.deliveryFails = false;
    state.mail = [];
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  const address = () => `emailed-invite-${++counter}@example.edu`;

  async function create(body: Record<string, unknown>) {
    const response = await app.request('/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const tokenOf = (link: string) => decodeURIComponent(link.split('#token=')[1] ?? '');
  /** The link as only the mailbox owner has it. */
  function tokenFromMail(to: string) {
    const mail = state.mail.find((m) => m.to === to && m.subject.includes('invited'));
    const link = mail?.text.match(/https?:\/\/\S+#token=\S+/)?.[0];
    expect(link, 'invitation email with a link').toBeTruthy();
    return tokenOf(link as string);
  }
  const accept = (token: string, email: string) =>
    acceptInvitation({ token, email, password, name: 'Invited Person' });
  async function userRow(email: string) {
    const [row] = await pool.db.select().from(schema.user).where(eq(schema.user.email, email));
    return row;
  }
  async function inviteRow(email: string) {
    const [row] = await pool.db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.email, email));
    return row;
  }
  /** Mail other than the invitation itself: the verification email, here. */
  const otherMail = () => state.mail.filter((m) => !m.subject.includes('invited'));
  /** What the admin list says about the invitation for this address, or the link-only one. */
  async function listed(email: string | null) {
    const response = await app.request('/invites');
    const { invites } = (await response.json()) as {
      invites: Array<{ email: string | null; emailedAt?: string | null }>;
    };
    return invites.find((invite) => invite.email === email);
  }
  async function audit(action: string, targetId: string) {
    const rows = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, targetId));
    return rows.filter((row) => row.action === action);
  }

  it('does not return the link when the email was delivered, and records when', async () => {
    const email = address();
    const { status, body } = await create({ email, role: 'user' });
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), emailDelivered: true });
    expect(JSON.stringify(body)).not.toContain('token');
    const row = await inviteRow(email);
    expect(row?.emailedAt).toBeInstanceOf(Date);
    // The link exists, but only in the mailbox.
    expect(tokenFromMail(email)).toBeTruthy();

    expect((await listed(email))?.emailedAt).toBe(row?.emailedAt?.toISOString());

    // The audit entry says it was emailed and never holds the token.
    const [entry] = await audit('invite.create', row?.id as string);
    expect(entry?.metadata).toMatchObject({ email, emailed: true });
    expect(JSON.stringify(entry?.metadata)).not.toContain(tokenFromMail(email));
  });

  it('creates a verified account from an emailed invitation and sends no verification email', async () => {
    const email = address();
    await create({ email, role: 'user' });
    const token = tokenFromMail(email);
    state.mail = [];

    const result = await accept(token, email);
    expect(result).toEqual({ emailVerificationRequired: false });
    expect((await userRow(email))?.emailVerified).toBe(true);
    expect(otherMail()).toEqual([]);
    expect(state.mail).toEqual([]);

    const row = await inviteRow(email);
    expect(row?.redeemedAt).toBeInstanceOf(Date);
    const [entry] = await audit('invite.redeem', row?.id as string);
    expect(entry?.metadata).toMatchObject({ roleApplied: true, emailVerifiedByInvitation: true });
  });

  it('still refuses the wrong address for an emailed invitation, and leaves it usable', async () => {
    const email = address();
    await create({ email, role: 'user' });
    const token = tokenFromMail(email);
    await expect(accept(token, address())).rejects.toMatchObject({
      message: expect.stringContaining('sent to a different email address'),
    });
    expect((await inviteRow(email))?.redeemedAt).toBeNull();
    expect(await accept(token, email)).toEqual({ emailVerificationRequired: false });
  });

  it.each([
    ['email is not configured', () => (state.smtpConfigured = false)],
    ['delivery fails', () => (state.deliveryFails = true)],
  ])('returns the link and does not verify when %s', async (_name, breakEmail) => {
    const email = address();
    breakEmail();
    const { status, body } = await create({ email, role: 'user' });
    expect(status).toBe(201);
    expect(body).toMatchObject({ emailDelivered: false, url: expect.stringContaining('#token=') });
    expect((await inviteRow(email))?.emailedAt).toBeNull();
    const [entry] = await audit('invite.create', (await inviteRow(email))?.id as string);
    expect(entry?.metadata).toMatchObject({ email, emailed: false });

    // Email works again by the time the person accepts: they still verify.
    state.smtpConfigured = true;
    state.deliveryFails = false;
    const result = await accept(tokenOf(body.url as string), email);
    expect(result).toEqual({ emailVerificationRequired: true });
    expect((await userRow(email))?.emailVerified).toBe(false);
    expect(otherMail().map((m) => m.to)).toEqual([email]);
  });

  it('still requires verification for a link-only invitation', async () => {
    const { status, body } = await create({ role: 'user' });
    expect(status).toBe(201);
    expect(body).toMatchObject({ emailDelivered: false, url: expect.stringContaining('#token=') });
    expect((await listed(null))?.emailedAt).toBeNull();
    const email = address();
    const result = await accept(tokenOf(body.url as string), email);
    expect(result).toEqual({ emailVerificationRequired: true });
    expect((await userRow(email))?.emailVerified).toBe(false);
    expect(otherMail().map((m) => m.to)).toEqual([email]);
  });

  it('treats an invitation created before the record (no emailed_at) as before', async () => {
    const email = address();
    const token = generateToken();
    // As the previous release stored it: an address, and no emailed_at.
    await pool.db.execute(
      sql`insert into invitation (organization_id, email, role, token_hash)
          values (${state.organizationId}, ${email}, 'user', ${hashToken(token)})`,
    );
    expect((await inviteRow(email))?.emailedAt).toBeNull();
    expect((await listed(email))?.emailedAt).toBeNull();
    const result = await accept(token, email);
    expect(result).toEqual({ emailVerificationRequired: true });
    expect((await userRow(email))?.emailVerified).toBe(false);
    expect(otherMail().map((m) => m.to)).toEqual([email]);
    const [entry] = await audit('invite.redeem', (await inviteRow(email))?.id as string);
    expect(entry?.metadata).not.toHaveProperty('emailVerifiedByInvitation');
  });
});
