import { eq, schema } from '@oci/db';
import type { db } from '../../db/index.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LAST_ADMIN_ROLE_MESSAGE =
  'This is the last administrator, so their role cannot be changed. Make someone else an administrator first.';
export const LAST_ADMIN_BAN_MESSAGE =
  'This is the last administrator, so the account cannot be banned. Make someone else an administrator first.';
export const LAST_ADMIN_BULK_MESSAGE =
  'This would leave no administrator who can sign in, so nothing was changed. Make someone else an administrator first.';

/**
 * Locks every administrator row, in id order, until the transaction ends.
 *
 * Every change that can take an administrator away (deletion, a role change,
 * a ban, single or in bulk) takes this lock first and then checks that one
 * would remain, so two administrators acting on each other at the same moment
 * are serialised: the second sees the first's change and is refused rather
 * than both committing and leaving nobody in charge (#304). PostgreSQL
 * re-reads a row it waited for, so one demoted meanwhile is no longer listed.
 */
export function lockAdministrators(tx: Transaction) {
  return tx
    .select({ id: schema.user.id, banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.role, 'admin'))
    .orderBy(schema.user.id)
    .for('update');
}

/**
 * Whether an administrator who can still sign in remains once the accounts
 * in `leaving` are no longer one. A banned administrator does not count: a
 * ban signs them out and keeps them out (#304).
 */
export function administratorRemains(
  admins: ReadonlyArray<{ id: string; banned: boolean }>,
  leaving: readonly string[],
): boolean {
  return admins.some((admin) => !admin.banned && !leaving.includes(admin.id));
}
