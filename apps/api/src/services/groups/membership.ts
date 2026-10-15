import { and, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';

/** Where a lookup runs: the pool, or the transaction that must see its own writes. */
export type GroupExecutor = Pick<typeof db, 'select'>;

/**
 * The ids of every group a person belongs to, as member or manager.
 *
 * One indexed read (`group_member_user_idx`), never cached: a removed member
 * loses what the group granted on their next request, and project access is
 * computed from this per request. Callers that need it twice in one request
 * should keep the array themselves rather than ask for a cache here.
 */
export async function groupIdsForUser(
  userId: string,
  executor: GroupExecutor = db,
): Promise<string[]> {
  const rows = await executor
    .select({ groupId: schema.groupMember.groupId })
    .from(schema.groupMember)
    .where(eq(schema.groupMember.userId, userId));
  return rows.map((row) => row.groupId);
}

/** True when the person is a member or manager of the group right now. */
export async function isGroupMember(
  groupId: string,
  userId: string,
  executor: GroupExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ groupId: schema.groupMember.groupId })
    .from(schema.groupMember)
    .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)))
    .limit(1);
  return Boolean(row);
}
