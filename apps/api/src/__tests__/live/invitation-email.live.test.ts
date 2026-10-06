import { createDatabase, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { generateToken, hashToken } from '../../lib/crypto.js';

/**
 * Opening an invitation link (#214), through the real route, settings and
 * PostgreSQL: the address an invitation is for is given to the page, which
 * fills it in, instead of asking for an address only one value of is accepted.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('opening an invitation link', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono;

  beforeAll(async () => {
    live = await createLiveDatabase('invite_email');
    pool = createDatabase(live.connectionString, { max: 2 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    await pool.db.execute(
      sql`insert into instance_setting (organization_id, key, value)
          values (${state.organizationId}, 'auth', ${JSON.stringify({
            localAuthEnabled: true,
            registrationMode: 'invite_only',
          })}::jsonb)`,
    );
    const { authStatusRoutes } = await import('../../routes/auth-status.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono();
    app.onError(errorHandler);
    app.route('/api/auth', authStatusRoutes);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function invite(token: string, email: string | null) {
    await pool.db.execute(
      sql`insert into invitation (organization_id, email, role, token_hash)
          values (${state.organizationId}, ${email}, 'user', ${hashToken(token)})`,
    );
  }
  const validate = async (token: string) => {
    const response = await app.request('/api/auth/accept-invite/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };

  it('gives the address an emailed invitation is for', async () => {
    const token = generateToken();
    await invite(token, 'Walk3-User@Example.edu');
    expect(await validate(token)).toEqual({
      emailLocked: true,
      email: 'walk3-user@example.edu',
    });
  });

  it('gives no address for an invitation that is not for one', async () => {
    const token = generateToken();
    await invite(token, null);
    expect(await validate(token)).toEqual({ emailLocked: false, email: null });
  });
});
