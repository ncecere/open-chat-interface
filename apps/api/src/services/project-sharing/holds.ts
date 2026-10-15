import { and, inArray, isNull, schema } from '@oci/db';
import type { db } from '../../db/index.js';

/**
 * True when any of these people is on legal hold now. Deleting a project, or a
 * file in one, is permanent (projects have no trash), so with sharing it is
 * refused when the actor or whoever added the data is held (v0.14): an editor's
 * files are that person's records even though they sit in someone else's
 * project. Pass the transaction to check under the locks it holds.
 */
export async function anyOnLegalHold(
  userIds: readonly string[],
  executor: Pick<typeof db, 'select'>,
): Promise<boolean> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return false;
  const [row] = await executor
    .select({ id: schema.legalHold.id })
    .from(schema.legalHold)
    .where(and(inArray(schema.legalHold.userId, unique), isNull(schema.legalHold.liftedAt)))
    .limit(1);
  return Boolean(row);
}
