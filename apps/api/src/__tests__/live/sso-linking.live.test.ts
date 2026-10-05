import { randomUUID } from 'node:crypto';
import { schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

const { assertSsoLinkAllowed, SSO_LINK_REFUSED_MESSAGE } = await import(
  '../../auth/sso-linking.js'
);

describe.skipIf(!available)('live: "Trust for account linking" for SSO providers', () => {
  let live: LiveDatabase;
  let organizationId: string;

  async function provider(providerId: string, trustedForLinking: boolean) {
    await live.db.insert(schema.ssoProvider).values({
      id: randomUUID(),
      providerId,
      issuer: `https://idp.example.test/${providerId}`,
      domain: 'northbrook.edu',
      organizationId,
      trustedForLinking,
      // Every provider may sign people in; this no longer means "may link".
      domainVerified: true,
    });
  }

  async function withPassword(userId: string) {
    await live.db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: 'hash',
    });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('sso_linking');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    await provider('walk-untrusted', false);
    await provider('walk-trusted', true);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lets an untrusted provider sign in a person it has just provisioned', async () => {
    // Just-in-time provisioning: the user row exists, with no sign-in method yet.
    const newcomer = await seedUser(live.db, organizationId, { role: 'user' });
    await expect(
      assertSsoLinkAllowed({ providerId: 'walk-untrusted', userId: newcomer }),
    ).resolves.toBeUndefined();
  });

  it('refuses to attach an untrusted provider to an account that already exists', async () => {
    const existing = await seedUser(live.db, organizationId, { role: 'admin' });
    await withPassword(existing);
    await expect(
      assertSsoLinkAllowed({ providerId: 'walk-untrusted', userId: existing }),
    ).rejects.toMatchObject({
      body: { code: 'ACCOUNT_NOT_LINKED', message: SSO_LINK_REFUSED_MESSAGE },
    });
  });

  it('lets a provider trusted for linking attach to an existing account', async () => {
    const existing = await seedUser(live.db, organizationId, { role: 'user' });
    await withPassword(existing);
    await expect(
      assertSsoLinkAllowed({ providerId: 'walk-trusted', userId: existing }),
    ).resolves.toBeUndefined();
  });

  it('does not affect sign-in methods that are not SSO logins', async () => {
    const existing = await seedUser(live.db, organizationId, { role: 'user' });
    await withPassword(existing);
    await expect(
      assertSsoLinkAllowed({ providerId: 'credential', userId: existing }),
    ).resolves.toBeUndefined();
  });
});
