import { and, asc, desc, eq, isNull, schema, sql } from '@oci/db';
import type { db as Database } from '../../db/index.js';
import { MAX_CONTEXT_FILES } from '../../services/chat/context-budget.js';

/**
 * The owner-only project queries exactly as v0.13.1 shipped them, kept as
 * reference code (v0.14, project sharing): `project-owner-parity.live.test.ts`
 * runs them beside the access-aware functions on data with owners and outsiders
 * and no shares, and requires the same answers. This is how "owner-only
 * behaviour is unchanged for people with no shares" is proven rather than
 * asserted. Do not edit these to follow the new code: they are the v0.13.1 text
 * (only the `db` parameter is new, so they can run against the test database).
 */
type Db = typeof Database;

const fileCountSql = sql<number>`(
  select count(*) from "attachment" as "project_file"
  where "project_file"."project_id" = "project"."id"
    and "project_file"."upload_pending" = false
    and "project_file"."deleted_at" is null
)::int`;

const threadCountSql = sql<number>`(
  select count(*) from "thread" as "project_thread"
  where "project_thread"."project_id" = "project"."id"
    and "project_thread"."user_id" = "project"."user_id"
    and "project_thread"."deleted_at" is null
    and "project_thread"."archived" = false
    and "project_thread"."temporary" = false
)::int`;

const summaryColumns = {
  id: schema.project.id,
  name: schema.project.name,
  instructions: schema.project.instructions,
  createdAt: schema.project.createdAt,
  updatedAt: schema.project.updatedAt,
  fileCount: fileCountSql,
  threadCount: threadCountSql,
};

/** v0.13.1 `getProjectSummary`: the owner's project or nothing. */
export async function referenceProjectSummary(db: Db, projectId: string, userId: string) {
  const [row] = await db
    .select(summaryColumns)
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** v0.13.1 `listProjects`. */
export async function referenceListProjects(db: Db, userId: string) {
  return db
    .select(summaryColumns)
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .orderBy(sql`lower(${schema.project.name})`, asc(schema.project.createdAt))
    .limit(100);
}

/** v0.13.1 sidebar: ids, names, counts, and the recent unpinned conversations per project. */
export async function referenceSidebar(db: Db, userId: string) {
  const projects = await db
    .select({ id: schema.project.id, name: schema.project.name, threadCount: threadCountSql })
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .orderBy(sql`lower(${schema.project.name})`, asc(schema.project.createdAt))
    .limit(100);
  if (projects.length === 0) return [];
  const owned = db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .as('owned');
  const recent = db
    .select()
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.projectId, owned.id),
        eq(schema.thread.userId, userId),
        eq(schema.thread.pinned, false),
        eq(schema.thread.archived, false),
        eq(schema.thread.temporary, false),
        isNull(schema.thread.deletedAt),
      ),
    )
    .orderBy(desc(schema.thread.updatedAt), desc(schema.thread.id))
    .limit(5)
    .as('recent');
  const rows = await db
    .select()
    .from(owned)
    .crossJoinLateral(recent)
    .orderBy(desc(recent.updatedAt), desc(recent.id));
  const byProject = new Map<string, string[]>();
  for (const { recent: thread } of rows) {
    if (!thread.projectId) continue;
    byProject.set(thread.projectId, [...(byProject.get(thread.projectId) ?? []), thread.id]);
  }
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    threadCount: Number(project.threadCount),
    recentThreadIds: byProject.get(project.id) ?? [],
  }));
}

/** v0.13.1 `listProjectFiles` (after its owner check): the ids in order. */
export async function referenceProjectFileIds(db: Db, projectId: string, userId: string) {
  const [owned] = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
    .limit(1);
  if (!owned) return null;
  const rows = await db
    .select({ id: schema.attachment.id })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.projectId, projectId),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
  return rows.map((row) => row.id);
}

/** v0.13.1 `inspectProjectFiles`: the ids of the context candidates. */
export async function referenceContextFileIds(db: Db, projectId: string, userId: string) {
  const rows = await db
    .select({ id: schema.attachment.id })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.projectId, projectId),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
        sql`octet_length(${schema.attachment.mimeType}) <= 256`,
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))
    .limit(MAX_CONTEXT_FILES);
  return rows.map((row) => row.id);
}

/** v0.13.1 `getOwnedAttachment`: the person's own ready attachment, or nothing. */
export async function referenceOwnedAttachmentId(db: Db, id: string, userId: string) {
  const [row] = await db
    .select({ id: schema.attachment.id })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.id, id),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * v0.13.1 `scopedChunks` condition, run as a query: the (attachment, ordinal)
 * pairs of the given files that the person's own project scope admits.
 */
export async function referenceScopedChunkKeys(
  db: Db,
  scope: { userId: string; projectId: string; fileIds: string[] },
) {
  if (scope.fileIds.length === 0) return [];
  const rows = await db.execute<{ attachment_id: string; ordinal: number }>(sql`
    select c.attachment_id, c.ordinal
    from project_file_chunk c
    join attachment a on a.id = c.attachment_id
    where c.attachment_id = any(array[${sql.join(
      scope.fileIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[])
      and a.user_id = ${scope.userId}
      and a.project_id = ${scope.projectId}
      and a.upload_pending = false
      and a.deleted_at is null
    order by c.attachment_id, c.ordinal
  `);
  return rows.map((row) => `${row.attachment_id}:${row.ordinal}`);
}
