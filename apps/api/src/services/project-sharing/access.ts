import { sql } from '@oci/db';
import type { ProjectAccessLevel } from '@oci/shared';
import { db } from '../../db/index.js';
import { forbidden, notFound } from '../../lib/errors.js';

/**
 * Who may do what with a project (v0.14, project sharing, #394). Everything that
 * reads or changes a project asks this module; the unit test
 * `project-data-paths.unit.test.ts` fails when a file that touches project data
 * has not been classified, so a new query cannot skip the question.
 *
 * The rule, in one sentence: the owner (`project.user_id`) is `owner`; anyone
 * else gets the highest permission among the shares that name them or a group
 * they belong to (`project_share`, `group_member`); everyone else gets `null`,
 * which the caller answers as 404 "Project not found" so existence never leaks.
 * Administrators and auditors have no special access to project content.
 *
 * Access is computed per request from the three tables, never cached and never
 * copied onto threads or files (invariant I-3). Two forms of the same rule:
 *
 * - `projectAccess` answers the level for one person and one project.
 * - `projectReadableBy` is the SQL twin for raw queries: an `EXISTS` that
 *   replaces `a.user_id = <person>` where a query used to say "the owner's".
 *   `project-access.live.test.ts` compares the two on generated data.
 */

/** A SQL fragment, as `sql` builds it. */
export type SqlFragment = ReturnType<typeof sql>;

/** Where a lookup runs: the pool, or the transaction that must see its own writes. */
export type AccessExecutor = Pick<typeof db, 'execute'>;

const RANK: Record<ProjectAccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };

/** True when `level` is at least `minimum`; `null` (no access) never is. */
export function meetsAccess(level: ProjectAccessLevel | null, minimum: ProjectAccessLevel) {
  return level !== null && RANK[level] >= RANK[minimum];
}

/**
 * A share of `s` names this person: directly, or through any group they are in.
 * Groups are read from `group_member` in the same statement, so a member removed
 * a moment ago has lost the access in the same instant.
 */
function namesPerson(share: string, userId: string): SqlFragment {
  return sql`(${sql.raw(share)}."subject_user_id" = ${userId}
    or ${sql.raw(share)}."subject_group_id" in (
      select "gm_access"."group_id" from "group_member" as "gm_access"
      where "gm_access"."user_id" = ${userId}))`;
}

/** An id to SQL: a column expression stays as it is, a string becomes a bound parameter. */
function idSql(id: SqlFragment | string): SqlFragment {
  return typeof id === 'string' ? sql`${id}` : id;
}

/**
 * The person's access to the project, or null when they have none (or the
 * project does not exist). One statement, one round trip.
 */
export async function projectAccess(
  executor: AccessExecutor,
  projectId: string,
  userId: string,
): Promise<ProjectAccessLevel | null> {
  if (!projectId || !userId) return null;
  const [row] = await executor.execute<{ owner: boolean; editor: boolean; viewer: boolean }>(sql`
    select
      ("p"."user_id" = ${userId}) as "owner",
      exists (
        select 1 from "project_share" as "ps_editor"
        where "ps_editor"."project_id" = "p"."id" and "ps_editor"."permission" = 'editor'
          and ${namesPerson('"ps_editor"', userId)}
      ) as "editor",
      exists (
        select 1 from "project_share" as "ps_any"
        where "ps_any"."project_id" = "p"."id" and ${namesPerson('"ps_any"', userId)}
      ) as "viewer"
    from "project" as "p"
    where "p"."id" = ${projectId}
  `);
  if (!row) return null;
  if (row.owner) return 'owner';
  if (row.editor) return 'editor';
  return row.viewer ? 'viewer' : null;
}

/**
 * Raw-SQL twin of `projectAccess(...) !== null`: true when the person owns the
 * project or any share names them or one of their groups. `projectId` is a
 * column expression (`sql\`a.project_id\``) or an id (bound). Evaluated once per
 * statement when the id is a parameter, per row when it is a column; both are
 * index lookups (`project_share_person_unique`, `project_share_group_unique`,
 * `group_member_user_idx`).
 */
export function projectReadableBy(projectId: SqlFragment | string, userId: string): SqlFragment {
  return sql`exists (
    select 1 from "project" as "pr_access"
    where "pr_access"."id" = ${idSql(projectId)}
      and ("pr_access"."user_id" = ${userId}
        or exists (
          select 1 from "project_share" as "ps_access"
          where "ps_access"."project_id" = "pr_access"."id"
            and ${namesPerson('"ps_access"', userId)}))
  )`;
}

/** As `projectReadableBy`, for the people who may change files and instructions: the owner and editors. */
export function projectEditableBy(projectId: SqlFragment | string, userId: string): SqlFragment {
  return sql`exists (
    select 1 from "project" as "pe_access"
    where "pe_access"."id" = ${idSql(projectId)}
      and ("pe_access"."user_id" = ${userId}
        or exists (
          select 1 from "project_share" as "pes_access"
          where "pes_access"."project_id" = "pe_access"."id"
            and "pes_access"."permission" = 'editor'
            and ${namesPerson('"pes_access"', userId)}))
  )`;
}

/**
 * The person's access, at least `minimum`, or an error: 404 "Project not found"
 * for no access (never 403, so existence does not leak), 403 for access that is
 * too little. Pass the transaction when the caller holds the project row lock.
 */
export async function requireProjectAccess(
  projectId: string,
  userId: string,
  minimum: ProjectAccessLevel = 'viewer',
  executor: AccessExecutor = db,
): Promise<ProjectAccessLevel> {
  const level = await projectAccess(executor, projectId, userId);
  if (!level) throw notFound('Project not found');
  if (!meetsAccess(level, minimum)) {
    throw forbidden(
      minimum === 'owner'
        ? 'Only the owner of a project can do that.'
        : 'You can view this project but not change it.',
    );
  }
  return level;
}

/**
 * The project id to copy onto a new conversation (a fork or an edit of one in a
 * project): the same project while the person can still read it, otherwise null,
 * so a copy never points at a project its owner cannot see (invariant I-2).
 */
export async function projectIdWhileReadable(
  executor: AccessExecutor,
  projectId: string | null,
  userId: string,
): Promise<string | null> {
  if (!projectId) return null;
  return (await projectAccess(executor, projectId, userId)) ? projectId : null;
}
