import type { Queryable } from './release-manifest.js';

/**
 * SAML sign-in was removed (#53). Its providers stay in `sso_provider`, but
 * they are no longer offered at sign-in, so an instance whose only way in is
 * an enabled SAML provider would have nobody able to sign in after the
 * upgrade. `migrate` (and a start with RUN_MIGRATIONS=true) calls this under
 * the migration lock, before applying anything, and refuses with what to do.
 *
 * It refuses only when ALL hold: an enabled SAML provider exists, local
 * (email and password) sign-in is turned off, and no OpenID Connect provider
 * is enabled. Anything else leaves someone able to sign in.
 *
 * It is about the upgrade, so it stops applying once the upgrade has happened:
 * after `invitation.emailed_at` (this release's migration `0046`) exists the
 * instance already runs without SAML. Refusing every later start would turn an
 * administrator's own change (deleting the last OpenID Connect provider, say)
 * into an API that cannot start, with nobody able to reach the page that fixes it.
 */
export class SamlSignInRemovedError extends Error {
  override name = 'SamlSignInRemovedError';

  constructor() {
    super(
      'SAML sign-in was removed in this release, and the only way to sign in to this instance ' +
        'is a SAML provider, so upgrading would lock everyone out. Before upgrading, turn on ' +
        'local sign-in (Admin → Authentication) or add an OpenID Connect provider, then run ' +
        'migrate again. Nothing was changed.',
    );
  }
}

async function columnsExist(client: Queryable, table: string, columns: string[]) {
  const rows = await client<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = any(${columns})
  `;
  return rows.length === columns.length;
}

/**
 * Whether upgrading would leave nobody able to sign in because the only way
 * in is SAML. False for a database that was never migrated (no tables yet) or
 * is too old to have the columns read: neither has a SAML provider to lose.
 */
export async function samlWouldLockOut(client: Queryable): Promise<boolean> {
  if (!(await columnsExist(client, 'sso_provider', ['kind', 'enabled']))) return false;
  if (!(await columnsExist(client, 'instance_setting', ['key', 'value']))) return false;
  // This release's own migration has been applied: the upgrade is done.
  if (await columnsExist(client, 'invitation', ['emailed_at'])) return false;

  const [row] = await client<[{ locked_out: boolean }]>`
    select (
      exists (select 1 from sso_provider where kind = 'saml' and enabled)
      -- Explicitly off: an unset policy is "unavailable", not an opt-out (auth/policy.ts).
      and exists (
        select 1 from instance_setting
        where key = 'auth' and value -> 'localAuthEnabled' = 'false'::jsonb
      )
      -- Every other kind is read as OpenID Connect, as the sign-in page does.
      and not exists (select 1 from sso_provider where kind <> 'saml' and enabled)
    ) as locked_out
  `;
  return row?.locked_out === true;
}
