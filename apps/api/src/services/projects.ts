import { and, asc, count, desc, eq, isNull, schema, sql } from '@oci/db';
import {
  type CreateProjectInput,
  MAX_FILES_PER_PROJECT,
  MAX_PROJECTS_PER_USER,
  type ProjectFile,
  type ProjectSummary,
  SIDEBAR_PROJECT_THREAD_LIMIT,
  type SidebarProject,
  type UpdateProjectInput,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';
import { type UploadResult, uploadAttachment } from './attachments/upload.js';
import { recordDeletions } from './compliance/deletions.js';
import { HELD_PROJECT_DELETION_MESSAGE, isOnLegalHold } from './compliance/holds.js';
import { lockLifecycleOwner } from './lifecycle/owner-lock.js';
import { indexUploadedProjectFile, projectFileIndexStatus } from './project-search/indexing.js';
import { assertRoleFeature } from './role-features.js';
import { serializeThread } from './thread-summary.js';

/**
 * Projects: a person's conversations grouped under shared instructions and
 * files. Every function here is scoped to the owner; another person's project
 * is reported as not found rather than forbidden, so its existence never leaks.
 *
 * Lock order, shared by every mutation that touches a project: the owner's
 * user row (KEY SHARE, as account deletion locks it first), then the project
 * row, then threads or the storage counter. Project deletion cascades into
 * threads (detaching them) and files (whose delete triggers update the
 * storage counter), so taking the project lock before either keeps moves,
 * uploads and deletion from deadlocking each other.
 */

/** Refuses every project operation when the role may not use projects (403). */
export async function assertProjectsAllowed(role: UserRole): Promise<void> {
  await assertRoleFeature(role, 'projects');
}

// Written with explicit aliases: inside a select list Drizzle renders column
// references unqualified, which a correlated subquery would resolve against
// its own table instead of the outer project row.
const fileCountSql = sql<number>`(
  select count(*) from "attachment" as "project_file"
  where "project_file"."project_id" = "project"."id"
    and "project_file"."upload_pending" = false
    and "project_file"."deleted_at" is null
)::int`;

// Pinned conversations count. The owner check is belt and braces: moves and
// creation already refuse another person's project.
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

type SummaryRow = {
  id: string;
  name: string;
  instructions: string;
  createdAt: Date;
  updatedAt: Date;
  fileCount: number;
  threadCount: number;
};

function serializeProject(row: SummaryRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    fileCount: Number(row.fileCount),
    threadCount: Number(row.threadCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeProjectFile(row: {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date | string;
  /** Null or absent until the file has been chunked for search. */
  chunkCount?: number | null;
}): ProjectFile {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: `/api/attachments/${row.id}/content`,
    thumbnailUrl: null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
    index: projectFileIndexStatus(row.chunkCount),
  };
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .orderBy(sql`lower(${schema.project.name})`, asc(schema.project.createdAt))
    .limit(MAX_PROJECTS_PER_USER);
  return rows.map(serializeProject);
}

/**
 * The sidebar's project tree (v0.9.1): every project in name order with its
 * live conversation count and its newest unpinned live conversations.
 *
 * Two bounded queries rather than one per project: the projects (at most
 * MAX_PROJECTS_PER_USER), then one lateral join that takes up to
 * SIDEBAR_PROJECT_THREAD_LIMIT conversations per project, newest first, which
 * thread_project_idx (project_id, updated_at) serves without a sort. Fetching
 * these separately from GET /api/threads is the point: a project whose
 * conversations are older than the person's 200 most recent would otherwise
 * look empty. Pinned conversations are left out because the sidebar lists
 * them in its Pinned section; archived, temporary and trashed ones are left
 * out exactly as listThreads leaves them out.
 */
export async function listSidebarProjects(userId: string): Promise<SidebarProject[]> {
  const projects = await db
    .select({ id: schema.project.id, name: schema.project.name, threadCount: threadCountSql })
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .orderBy(sql`lower(${schema.project.name})`, asc(schema.project.createdAt))
    .limit(MAX_PROJECTS_PER_USER);
  if (projects.length === 0) return [];

  // Only the ids go through the join, so project instructions are not
  // repeated on every row.
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
    .limit(SIDEBAR_PROJECT_THREAD_LIMIT)
    .as('recent');
  const rows = await db
    .select()
    .from(owned)
    .crossJoinLateral(recent)
    .orderBy(desc(recent.updatedAt), desc(recent.id));

  const byProject = new Map<string, SidebarProject['recentThreads']>();
  for (const { recent: thread } of rows) {
    if (!thread.projectId) continue;
    const list = byProject.get(thread.projectId) ?? [];
    list.push(serializeThread(thread));
    byProject.set(thread.projectId, list);
  }
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    threadCount: Number(project.threadCount),
    recentThreads: byProject.get(project.id) ?? [],
  }));
}

/** The owner's project, or 404. */
export async function getOwnedProject(projectId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Project not found');
  return row;
}

export async function getProjectSummary(projectId: string, userId: string) {
  const [row] = await db
    .select(summaryColumns)
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Project not found');
  return serializeProject(row);
}

export async function createProject(params: {
  userId: string;
  organizationId: string;
  input: CreateProjectInput;
}): Promise<ProjectSummary> {
  const row = await db.transaction(async (tx) => {
    // Serialise creation per person so concurrent requests cannot pass the
    // limit together. NO KEY UPDATE does not block uploads or chat turns,
    // which only take KEY SHARE on the user row.
    const [owner] = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, params.userId))
      .for('no key update');
    if (!owner) throw notFound('User not found');
    const [existing] = await tx
      .select({ value: count() })
      .from(schema.project)
      .where(eq(schema.project.userId, params.userId));
    if ((existing?.value ?? 0) >= MAX_PROJECTS_PER_USER) {
      throw validationFailed(
        `You can have at most ${MAX_PROJECTS_PER_USER} projects. Delete one to make room.`,
      );
    }
    const [created] = await tx
      .insert(schema.project)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        name: params.input.name,
        instructions: params.input.instructions,
      })
      .returning();
    if (!created) throw new Error('Failed to create project');
    return created;
  });
  return serializeProject({ ...row, fileCount: 0, threadCount: 0 });
}

export async function updateProject(
  projectId: string,
  userId: string,
  patch: UpdateProjectInput,
): Promise<ProjectSummary> {
  const [updated] = await db
    .update(schema.project)
    .set(patch)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
    .returning({ id: schema.project.id });
  if (!updated) throw notFound('Project not found');
  return getProjectSummary(projectId, userId);
}

/**
 * Deletes a project now. Its conversations are kept and simply leave the
 * project; its files are deleted, which releases their storage at once and
 * queues the stored objects through the usual attachment delete trigger.
 *
 * Projects have no trash, so this is a permanent deletion and, like "delete
 * forever", is refused while the owner is on legal hold (409). Recorded as one
 * `project.delete` event naming the files that went with it.
 */
export async function deleteProject(
  projectId: string,
  userId: string,
): Promise<{ detachedThreads: number; removedFiles: number }> {
  return db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, userId))) throw notFound('Project not found');
    const [project] = await tx
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
      .for('update');
    if (!project) throw notFound('Project not found');
    if (await isOnLegalHold(userId, tx)) throw conflict(HELD_PROJECT_DELETION_MESSAGE);

    const [threads] = await tx
      .select({ value: count() })
      .from(schema.thread)
      .where(eq(schema.thread.projectId, projectId));
    // ON DELETE CASCADE removes these rows; the triggers release their bytes.
    const files = await tx
      .select({ id: schema.attachment.id })
      .from(schema.attachment)
      .where(eq(schema.attachment.projectId, projectId))
      .orderBy(asc(schema.attachment.id));
    await recordDeletions(tx, [
      {
        action: 'project.delete',
        actorUserId: userId,
        id: projectId,
        ownerUserId: userId,
        reason: 'user',
        details: {
          conversationsDetached: threads?.value ?? 0,
          files: files.length,
          fileIds: files.map((file) => file.id),
        },
      },
    ]);
    await tx.delete(schema.project).where(eq(schema.project.id, projectId));
    return { detachedThreads: threads?.value ?? 0, removedFiles: files.length };
  });
}

export async function listProjectFiles(projectId: string, userId: string) {
  await getOwnedProject(projectId, userId);
  const rows = await db
    .select({
      id: schema.attachment.id,
      filename: schema.attachment.filename,
      mimeType: schema.attachment.mimeType,
      sizeBytes: schema.attachment.sizeBytes,
      createdAt: schema.attachment.createdAt,
      chunkCount: schema.projectFileIndex.chunkCount,
    })
    .from(schema.attachment)
    .leftJoin(
      schema.projectFileIndex,
      eq(schema.projectFileIndex.attachmentId, schema.attachment.id),
    )
    .where(
      and(
        eq(schema.attachment.projectId, projectId),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
  return rows.map(serializeProjectFile);
}

/**
 * Adds one file through the ordinary upload path: the same validation, type
 * detection, text extraction, storage driver and storage allowance as a chat
 * attachment, plus the per-project file limit. The file is then chunked for
 * search; if that fails the upload still stands and the `projects.index-files`
 * job retries it.
 */
export async function uploadProjectFile(params: {
  userId: string;
  role: UserRole;
  projectId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
}): Promise<UploadResult & { chunkCount: number | null }> {
  const uploaded = await uploadAttachment({
    userId: params.userId,
    role: params.role,
    filename: params.filename,
    declaredMimeType: params.declaredMimeType,
    bytes: params.bytes,
    project: { id: params.projectId, maxFiles: MAX_FILES_PER_PROJECT },
  });
  await indexUploadedProjectFile(uploaded.id);
  const [index] = await db
    .select({ chunkCount: schema.projectFileIndex.chunkCount })
    .from(schema.projectFileIndex)
    .where(eq(schema.projectFileIndex.attachmentId, uploaded.id));
  return { ...uploaded, chunkCount: index?.chunkCount ?? null };
}

/**
 * Removes a project file outright rather than to the trash: a project file
 * has no conversation to restore it with. The attachment delete triggers
 * release the counted storage and queue the object for the storage reaper.
 * Being permanent, it is refused while the owner is on legal hold (409).
 */
export async function deleteProjectFile(
  projectId: string,
  fileId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, userId))) throw notFound('Project not found');
    const [project] = await tx
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
      .for('update');
    if (!project) throw notFound('Project not found');
    if (await isOnLegalHold(userId, tx)) throw conflict(HELD_PROJECT_DELETION_MESSAGE);
    const deleted = await tx
      .delete(schema.attachment)
      .where(
        and(
          eq(schema.attachment.id, fileId),
          eq(schema.attachment.projectId, projectId),
          eq(schema.attachment.userId, userId),
          eq(schema.attachment.uploadPending, false),
        ),
      )
      .returning({ id: schema.attachment.id, sizeBytes: schema.attachment.sizeBytes });
    if (deleted.length === 0) throw notFound('File not found');
    await recordDeletions(tx, [
      {
        action: 'attachment.delete',
        actorUserId: userId,
        id: fileId,
        ownerUserId: userId,
        reason: 'user',
        details: { projectId, sizeBytes: deleted[0]!.sizeBytes },
      },
    ]);
  });
}

/**
 * Puts a conversation into one of the owner's projects, or takes it out with
 * `null`. Temporary chats stay out of projects: they are deliberately kept out
 * of history.
 */
export async function moveThreadToProject(
  threadId: string,
  userId: string,
  projectId: string | null,
) {
  return db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, userId))) throw notFound('Thread not found');
    if (projectId) {
      // Project before thread, matching deletion's lock order.
      const [project] = await tx
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, userId)))
        .for('key share');
      if (!project) throw notFound('Project not found');
    }
    const [thread] = await tx
      .select({ id: schema.thread.id, temporary: schema.thread.temporary })
      .from(schema.thread)
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          isNull(schema.thread.deletedAt),
        ),
      )
      .for('update');
    if (!thread) throw notFound('Thread not found');
    if (projectId && thread.temporary) {
      throw validationFailed('Temporary chats cannot be added to a project');
    }
    const [updated] = await tx
      .update(schema.thread)
      .set({ projectId })
      .where(eq(schema.thread.id, threadId))
      .returning();
    if (!updated) throw notFound('Thread not found');
    return updated;
  });
}
