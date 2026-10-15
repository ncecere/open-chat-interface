import type { db } from '../../db/index.js';

/** The transaction a group change runs in. */
export type GroupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where project sharing hears that people lost group membership.
 *
 * The groups code calls these inside the transaction that removes the rows,
 * after the group row (and, for several people, their user rows in id order)
 * is locked, so project sharing can detach threads and hand over files in the
 * same transaction (`reconcileProject`, project sharing spec "When access
 * ends"). They do nothing until project sharing fills them in; the call
 * sites, arguments and lock order are fixed here.
 *
 * Lock order: the group row, then user rows by id, then (in the hook) project
 * rows, thread rows, `storage_usage` rows by user id.
 */

/** Members were removed from a group (by an administrator, a manager, or themselves). */
export async function onGroupMembersRemoved(
  _tx: GroupTransaction,
  _groupId: string,
  _userIds: string[],
): Promise<void> {}

/**
 * A group is about to be deleted; `memberIds` are its members, who lose
 * whatever it shared with them. Called before the group row is deleted, so a
 * share naming the group can still be read.
 */
export async function onGroupDeleting(
  _tx: GroupTransaction,
  _groupId: string,
  _memberIds: string[],
): Promise<void> {}

/**
 * How many projects are shared with the group, for the delete dialog and the
 * `sharedProjects` figure of the audit entry. Zero until project sharing
 * (migration 0054) provides the count.
 */
export async function countGroupSharedProjects(
  _tx: Pick<typeof db, 'execute'>,
  _groupId: string,
): Promise<number> {
  return 0;
}
