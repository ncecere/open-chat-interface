import { and, eq, schema, sql } from '@oci/db';
import type { db } from '../../db/index.js';
import {
  auditAccessRevoked,
  projectsSharedWithGroup,
  projectsTouchedBy,
  type ReconcileResult,
  reconcileProject,
} from '../project-sharing/reconcile.js';

/** The transaction a group change runs in. */
export type GroupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where project sharing hears that people lost group membership.
 *
 * The groups code calls these inside the transaction that removes the rows,
 * after the group row (and, for several people, their user rows in id order)
 * is locked, so project sharing detaches threads and hands over files in the
 * same transaction (`reconcileProject`, project sharing spec "When access
 * ends"), instead of leaving it to the one-minute `projects.reconcile-access`
 * job. Access checks refuse at the next request either way; this restores the
 * invariants at once.
 *
 * Lock order: the group row, then user rows by id, then (in the hook) project
 * rows in id order, thread rows, `storage_usage` rows by user id.
 */

/** What one reconcile changed in one project, to be audited once the transaction has committed. */
export interface Revocation {
  projectId: string;
  result: ReconcileResult;
}

/** Reconcile each project once, in id order, so two changes cannot deadlock on the same pair. */
async function reconcileAll(
  tx: GroupTransaction,
  projectIds: Iterable<string>,
): Promise<Revocation[]> {
  const revoked: Revocation[] = [];
  for (const projectId of [...new Set(projectIds)].sort()) {
    revoked.push({ projectId, result: await reconcileProject(tx, projectId) });
  }
  return revoked;
}

/** Audit what the hooks changed (counts only). Call it after the transaction has committed. */
export async function auditRevocations(revoked: Revocation[]): Promise<void> {
  for (const { projectId, result } of revoked) {
    await auditAccessRevoked(projectId, result, 'membership');
  }
}

/**
 * Members were removed from a group (by an administrator, a manager, or
 * themselves). Every project that has a conversation or a file of theirs is
 * reconciled against the access that remains: a person who still reaches it by
 * another share, group or as its owner keeps everything.
 */
export async function onGroupMembersRemoved(
  tx: GroupTransaction,
  _groupId: string,
  userIds: string[],
): Promise<Revocation[]> {
  const touched: string[] = [];
  for (const userId of [...userIds].sort()) {
    touched.push(...(await projectsTouchedBy(tx, userId)));
  }
  return reconcileAll(tx, touched);
}

/**
 * A group is about to be deleted; `memberIds` are its members, who lose
 * whatever it shared with them. Called before the group row is deleted, while
 * shares naming the group can still be read (to note which projects they
 * reach). It returns a function that runs in the same transaction AFTER the
 * group, its memberships and its shares are gone, which reconciles those
 * projects against the access that remains.
 */
export async function onGroupDeleting(
  tx: GroupTransaction,
  groupId: string,
  _memberIds: string[],
): Promise<undefined | (() => Promise<Revocation[]>)> {
  const projectIds = await projectsSharedWithGroup(tx, groupId);
  if (projectIds.length === 0) return undefined;
  return () => reconcileAll(tx, projectIds);
}

/**
 * How many projects are shared with the group, for the delete dialog and the
 * `sharedProjects` figure of the audit entry.
 */
export async function countGroupSharedProjects(
  tx: Pick<typeof db, 'select'>,
  groupId: string,
): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`count(distinct ${schema.projectShare.projectId})::int` })
    .from(schema.projectShare)
    .where(and(eq(schema.projectShare.subjectGroupId, groupId)));
  return row?.value ?? 0;
}
