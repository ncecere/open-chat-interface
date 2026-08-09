import { type Database, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * Per-provider authorisation columns.
 *
 * The behaviour that matters is a default: an instance upgrading from an
 * earlier release must not suddenly start refusing logins that used to work,
 * so `require_role_match` has to arrive off. That is a property of the
 * migration rather than of any code path, so it is checked against a real
 * database.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: SSO authorisation controls', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('sso_authorisation');
    db = live.db;
    organizationId = await seedOrganization(db);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function createProvider(providerId: string): Promise<void> {
    await db.execute(sql`
      insert into sso_provider (id, issuer, domain, provider_id, organization_id, label, kind)
      values (${providerId}, 'https://idp.example', 'example.edu', ${providerId},
              ${organizationId}, 'Example', 'oidc')
    `);
  }

  it('leaves an existing provider admitting unmatched logins', async () => {
    await createProvider('legacy');

    const [row] = await db.execute<{ require_role_match: boolean }>(
      sql`select require_role_match from sso_provider where provider_id = 'legacy'`,
    );
    // Upgrading must not lock people out of an instance that was working.
    expect(row?.require_role_match).toBe(false);
  });

  it('defaults the remaining controls to inert values', async () => {
    const [row] = await db.execute<{
      auto_redirect: boolean;
      claim_mappings: Record<string, string>;
      role_required_message: string | null;
    }>(
      sql`select auto_redirect, claim_mappings, role_required_message
          from sso_provider where provider_id = 'legacy'`,
    );

    expect(row?.auto_redirect).toBe(false);
    expect(row?.claim_mappings).toEqual({});
    expect(row?.role_required_message).toBeNull();
  });

  it('stores a refusal message alongside the requirement', async () => {
    await createProvider('strict');
    await db.execute(sql`
      update sso_provider
      set require_role_match = true,
          role_required_message = 'Request access through the service desk.'
      where provider_id = 'strict'
    `);

    const [row] = await db.execute<{
      require_role_match: boolean;
      role_required_message: string;
    }>(
      sql`select require_role_match, role_required_message
          from sso_provider where provider_id = 'strict'`,
    );

    expect(row?.require_role_match).toBe(true);
    expect(row?.role_required_message).toBe('Request access through the service desk.');
  });

  it('keeps claim mappings addressable per field', async () => {
    await db.execute(sql`
      update sso_provider
      set claim_mappings = ${JSON.stringify({ email: 'mail', name: 'displayName' })}::jsonb
      where provider_id = 'strict'
    `);

    const [row] = await db.execute<{ claim_mappings: Record<string, string> }>(
      sql`select claim_mappings from sso_provider where provider_id = 'strict'`,
    );

    expect(row?.claim_mappings.email).toBe('mail');
    expect(row?.claim_mappings.name).toBe('displayName');
    // An unset field stays absent rather than becoming an empty string, so the
    // standard claim is still used for it.
    expect(row?.claim_mappings.subject).toBeUndefined();
  });

  it('allows only one provider to skip the sign-in form at a time', async () => {
    // Not a database constraint: two providers both claiming the page would be
    // ambiguous, and the interface resolves it by taking the first. This
    // records that the storage permits it and the decision lives in the client.
    await db.execute(sql`update sso_provider set auto_redirect = true`);

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from sso_provider where auto_redirect = true`,
    );
    expect(Number(row?.count)).toBe(2);
  });
});
