import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrationsWithLock, SamlSignInRemovedError, sql } from '@oci/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * SAML sign-in was removed (#53). An instance whose only way to sign in is a
 * SAML provider would have nobody able to sign in after upgrading, so
 * `migrate` (and a start with RUN_MIGRATIONS=true: both call
 * runMigrationsWithLock) refuses, changing nothing, when ALL hold: an enabled
 * SAML provider exists, local sign-in is off, and no OpenID Connect provider
 * is enabled. Real rows in a real database; the pending migration is a probe
 * table, so "changes nothing" is observable.
 */

const available = await livePostgresAvailable();
const WHEN = 4_100_000_000_000;
const TAG = '9000_lockout_probe';

describe.skipIf(!available)('live PostgreSQL: SAML lockout guard in migrate', () => {
  let live: LiveDatabase;
  let folder: string;
  let organizationId: string;

  beforeEach(async () => {
    live = await createLiveDatabase('saml_lockout');
    organizationId = await seedOrganization(live.db);
    folder = await mkdtemp(join(tmpdir(), 'oci-saml-lockout-'));
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: WHEN, tag: TAG, breakpoints: true }],
      }),
    );
    await writeFile(join(folder, `${TAG}.sql`), 'CREATE TABLE "lockout_probe" ("id" text);');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
    await live?.destroy();
  });

  const migrate = () =>
    runMigrationsWithLock(live.connectionString, {
      migrationsFolder: folder,
      releaseManifest: [],
      maxAttempts: 1,
    });

  async function probeExists(): Promise<boolean> {
    const [row] = await live.db.execute<{ found: boolean }>(
      sql`select to_regclass('public.lockout_probe') is not null as found`,
    );
    return row!.found;
  }

  async function localSignIn(enabled: boolean) {
    await live.db.execute(sql`
      insert into instance_setting (organization_id, key, value)
      values (${organizationId}, 'auth', ${JSON.stringify({
        registrationMode: 'invite_only',
        emailVerificationRequired: true,
        localAuthEnabled: enabled,
      })}::jsonb)
      on conflict (organization_id, key) do update set value = excluded.value
    `);
  }

  async function provider(kind: 'saml' | 'oidc', enabled: boolean) {
    const providerId = `${kind}-${randomUUID().slice(0, 8)}`;
    await live.db.execute(sql`
      insert into sso_provider (id, issuer, domain, provider_id, organization_id, label, kind, enabled)
      values (${randomUUID()}, ${`https://${providerId}.example.test`}, 'example.test',
        ${providerId}, ${organizationId}, ${providerId}, ${kind}, ${enabled})
    `);
  }

  async function refusal() {
    const refused = await migrate().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SamlSignInRemovedError);
    return (refused as Error).message;
  }

  it('refuses when the only way to sign in is an enabled SAML provider, and changes nothing', async () => {
    await provider('saml', true);
    await provider('oidc', false);
    await localSignIn(false);

    const message = await refusal();
    expect(message).toContain('SAML sign-in was removed in this release');
    expect(message).toContain('lock everyone out');
    expect(message).toContain('turn on local sign-in (Admin → Authentication)');
    expect(message).toContain('add an OpenID Connect provider, then run migrate again');
    expect(message).toContain('Nothing was changed');
    // The pending migration was not applied, and the rows are as they were.
    expect(await probeExists()).toBe(false);
    const [counts] = await live.db.execute<{ providers: number }>(
      sql`select count(*)::int as providers from sso_provider`,
    );
    expect(counts?.providers).toBe(2);

    // Each way out the message names lets the same migrate run.
    await localSignIn(true);
    await expect(migrate()).resolves.toEqual({ applied: true });
    expect(await probeExists()).toBe(true);
  });

  it('lets migrate run once an OpenID Connect provider is enabled', async () => {
    await provider('saml', true);
    await localSignIn(false);
    await refusal();
    await provider('oidc', true);
    await expect(migrate()).resolves.toEqual({ applied: true });
    expect(await probeExists()).toBe(true);
  });

  it('does not refuse while local sign-in is on', async () => {
    await provider('saml', true);
    await localSignIn(true);
    await expect(migrate()).resolves.toEqual({ applied: true });
    expect(await probeExists()).toBe(true);
  });

  it('does not refuse when an OpenID Connect provider is enabled', async () => {
    await provider('saml', true);
    await provider('oidc', true);
    await localSignIn(false);
    await expect(migrate()).resolves.toEqual({ applied: true });
  });

  it('does not refuse for a SAML provider that is disabled', async () => {
    await provider('saml', false);
    await localSignIn(false);
    await expect(migrate()).resolves.toEqual({ applied: true });
  });

  it('does not refuse with no providers, or with no authentication setting stored', async () => {
    await localSignIn(false);
    await expect(migrate()).resolves.toEqual({ applied: true });

    await live.db.execute(sql`delete from instance_setting`);
    await provider('saml', true);
    await expect(migrate()).resolves.toEqual({ applied: true });
  });

  it('does not refuse a new database, which has no tables yet', async () => {
    await live.db.execute(sql`drop schema drizzle cascade`);
    await live.db.execute(sql`drop schema public cascade`);
    await live.db.execute(sql`create schema public`);
    await expect(migrate()).resolves.toEqual({ applied: true });
    expect(await probeExists()).toBe(true);
  });
});
