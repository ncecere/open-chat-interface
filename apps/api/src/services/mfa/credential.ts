import { and, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';

/**
 * True for an account with a password (a `credential` row): the only kind that
 * can set up a second step, and the only kind the per-role requirement applies
 * to. A person with only single sign-on accounts is never limited: the plugin
 * challenges password sign-in only, and their identity provider enforces its own.
 */
export async function hasCredentialAccount(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')))
    .limit(1);
  return Boolean(row);
}
