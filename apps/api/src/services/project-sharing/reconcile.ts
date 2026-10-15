import { and, asc, eq, inArray, schema, sql } from '@oci/db';
import type { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { attachmentTotals, lockStorageUsage } from '../storage/usage.js';
import { projectEditableBy, projectReadableBy } from './access.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Putting a project back in line with who may use it (v0.14, project sharing).
 *
 * Invariants this keeps (SPEC-groups.md):
 * - **I-1** every finished project file is owned by the project's owner or by
 *   someone who currently has editor access. Unfinished uploads stay with their
 *   uploader until they complete.
 * - **I-2** a person's conversation points at a project only if they can read it.
 *   Reads re-check access anyway, so a missed repair leaks nothing: this keeps
 *   the sidebar and the counts honest.
 *
 * Called in the same transaction as every event that ends access (a share
 * removed or downgraded, someone leaving, a transfer), with the project row
 * already locked by the caller, in the lock order `projects.ts` documents:
 * the acting person's user row, the project, threads, then the storage counters
 * by user id. A job repeats it for leftovers (an upload that finished after its
 * uploader lost access, a membership removed by code that did not reconcile).
 *
 * It never refuses for lack of allowance (a fork never does either, see
 * docs/dev/database.md "Files in forks and edits"), never deletes a conversation
 * or a message, and is idempotent: a second run finds nothing to do.
 */
export interface ReconcileResult {
  /** Conversations taken out of the project because their person no longer has access. */
  detachedThreads: number;
  /** Finished files handed to the owner because their uploader is no longer an editor. */
  movedFiles: number;
  /** How many people's conversations or files that touched. */
  people: number;
}

export async function reconcileProject(
  tx: Transaction,
  projectId: string,
): Promise<ReconcileResult> {
  const [project] = await tx
    .select({ userId: schema.project.userId, organizationId: schema.project.organizationId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .limit(1);
  if (!project) return { detachedThreads: 0, movedFiles: 0, people: 0 };

  // (a) Conversations of people with no access leave the project. Rows locked in
  // id order so two reconciles (or a reconcile and a move) cannot deadlock. The
  // statement is raw SQL: Drizzle's $onUpdate would bump updated_at and reorder
  // the person's recent conversations for a change they did not make.
  const detached = await tx.execute<{ user_id: string }>(sql`
    update "thread" set "project_id" = null
    where "id" in (
      select "t"."id" from "thread" as "t"
      where "t"."project_id" = ${projectId}
        and not ${projectReadableBy(projectId, sql`"t"."user_id"`)}
      order by "t"."id"
      for update
    )
    returning "user_id"
  `);

  // (b) Finished files of anyone who is no longer the owner or an editor go to the owner.
  const strays = await tx
    .select({ id: schema.attachment.id, userId: schema.attachment.userId })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.projectId, projectId),
        eq(schema.attachment.uploadPending, false),
        sql`not ${projectEditableBy(projectId, sql`${schema.attachment.userId}`)}`,
      ),
    )
    .orderBy(asc(schema.attachment.id))
    .for('update');
  const touched = new Set(detached.map((row) => row.user_id));
  const movedFiles = await handFilesToOwner(tx, { projectId, ...project }, strays);
  for (const row of strays) touched.add(row.userId);
  return { detachedThreads: detached.length, movedFiles, people: touched.size };
}

/**
 * Moves the given project files (rows already locked) to the project's owner and
 * sets the counters of everyone involved to the authoritative totals of their rows,
 * locking the counters in user-id order. Not a deletion: allowed under a legal hold.
 */
async function handFilesToOwner(
  tx: Transaction,
  project: { projectId: string; userId: string; organizationId: string },
  files: Array<{ id: string; userId: string }>,
): Promise<number> {
  if (files.length === 0) return 0;
  const losers = [...new Set(files.map((row) => row.userId))];
  const involved = [...new Set([project.userId, ...losers])].sort();
  for (const userId of involved) {
    await lockStorageUsage(tx, { organizationId: project.organizationId, userId });
  }
  const moved = await tx
    .update(schema.attachment)
    .set({ userId: project.userId })
    .where(
      and(
        inArray(
          schema.attachment.id,
          files.map((row) => row.id),
        ),
        eq(schema.attachment.projectId, project.projectId),
      ),
    )
    .returning({ id: schema.attachment.id });
  // The totals of the rows, as an upload sets them: the counters cannot drift
  // however the hand-over interleaves with other writes.
  for (const userId of involved) {
    const totals = await attachmentTotals(tx, userId);
    await tx
      .update(schema.storageUsage)
      .set({ ...totals, updatedAt: new Date() })
      .where(eq(schema.storageUsage.userId, userId));
  }
  return moved.length;
}

/**
 * Before an account is deleted: the finished files it added to projects other
 * people own go to those owners, so the cascade on `attachment.user_id` does not
 * delete another person's project content (v0.14). Unfinished uploads are left to
 * cascade with the account. Each project row is locked first, in id order.
 * Returns the number of files handed over.
 */
export async function handOverFilesOf(tx: Transaction, userId: string): Promise<number> {
  const projects = await tx.execute<{ id: string }>(sql`
    select distinct "p"."id" from "attachment" as "a"
    join "project" as "p" on "p"."id" = "a"."project_id"
    where "a"."user_id" = ${userId} and "a"."upload_pending" = false and "p"."user_id" <> ${userId}
    order by "p"."id"
  `);
  let moved = 0;
  for (const { id } of projects) {
    const [project] = await tx
      .select({ userId: schema.project.userId, organizationId: schema.project.organizationId })
      .from(schema.project)
      .where(eq(schema.project.id, id))
      .for('update');
    if (!project) continue;
    const files = await tx
      .select({ id: schema.attachment.id, userId: schema.attachment.userId })
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.projectId, id),
          eq(schema.attachment.userId, userId),
          eq(schema.attachment.uploadPending, false),
        ),
      )
      .orderBy(asc(schema.attachment.id))
      .for('update');
    moved += await handFilesToOwner(tx, { projectId: id, ...project }, files);
  }
  return moved;
}

/** One system audit entry when a reconcile changed something; counts only, no names. */
export async function auditAccessRevoked(
  projectId: string,
  result: ReconcileResult,
  cause: 'share' | 'membership' | 'job',
): Promise<void> {
  if (result.detachedThreads === 0 && result.movedFiles === 0) return;
  await recordAudit({
    action: 'project.access.revoked',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      cause,
      detachedConversations: result.detachedThreads,
      movedFiles: result.movedFiles,
      people: result.people,
    },
  });
}

/** How many projects one run of the job repairs; the rest wait for the next minute. */
export const RECONCILE_BATCH = 100;

/**
 * `projects.reconcile-access` (every minute): repairs leftovers. A project is a
 * candidate when it has a conversation by someone who cannot read it, or a
 * finished file by someone who is neither the owner nor an editor. Each is
 * repaired in its own transaction with the project row locked (skipping a
 * project another transaction is changing: the next run gets it). Returns the
 * number of projects it changed.
 */
export async function reconcileAccessLeftovers(database: typeof db): Promise<number> {
  const candidates = await database.execute<{ id: string }>(sql`
    select "id" from (
      select distinct "t"."project_id" as "id" from "thread" as "t"
      where "t"."project_id" is not null
        and not ${projectReadableBy(sql`"t"."project_id"`, sql`"t"."user_id"`)}
      union
      select distinct "a"."project_id" as "id" from "attachment" as "a"
      where "a"."project_id" is not null and "a"."upload_pending" = false
        and not ${projectEditableBy(sql`"a"."project_id"`, sql`"a"."user_id"`)}
    ) as "leftovers"
    order by "id"
    limit ${RECONCILE_BATCH}
  `);
  let changed = 0;
  for (const { id } of candidates) {
    try {
      const result = await database.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(eq(schema.project.id, id))
          .for('update', { skipLocked: true });
        if (!locked) return null;
        return reconcileProject(tx, id);
      });
      if (result && (result.detachedThreads > 0 || result.movedFiles > 0)) {
        changed += 1;
        await auditAccessRevoked(id, result, 'job');
      }
    } catch (error) {
      // One project failing (a deadlock with a delete, say) must not stop the rest.
      logger.warn(
        { err: error, projectId: id },
        'Reconciling project access failed; retrying next run',
      );
    }
  }
  return changed;
}

/** Every project that has a conversation or a file of this person; for a membership that ended. */
export async function projectsTouchedBy(tx: Transaction, userId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct "id" from (
      select "t"."project_id" as "id" from "thread" as "t"
        where "t"."user_id" = ${userId} and "t"."project_id" is not null
      union
      select "a"."project_id" as "id" from "attachment" as "a"
        where "a"."user_id" = ${userId} and "a"."project_id" is not null
    ) as "touched" order by "id"
  `);
  return rows.map((row) => row.id);
}

/** For groups: reconcile every project shared with a group, after its membership or existence changed. */
export async function projectsSharedWithGroup(tx: Transaction, groupId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: schema.projectShare.projectId })
    .from(schema.projectShare)
    .where(eq(schema.projectShare.subjectGroupId, groupId))
    .orderBy(asc(schema.projectShare.projectId));
  return rows.map((row) => row.id);
}
