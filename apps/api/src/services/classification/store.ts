import { and, asc, count, eq, inArray, isNull, schema, sql } from '@oci/db';
import {
  type AdminDataClass,
  type AdminUserProject,
  type DataClass,
  MAX_DATA_CLASSES,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { lockChatThread } from '../chat/thread-claim.js';
import { getDefaultOrganizationId } from '../organization.js';
import { requireProjectAccess } from '../project-sharing/access.js';
import { loadClasses } from './resolve.js';

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ClassRow = typeof schema.dataClass.$inferSelect;

/** The PostgreSQL error code and constraint of a failed write, through the driver's wrapping. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  let cause = error;
  while (cause && typeof cause === 'object') {
    if ('code' in cause && typeof cause.code === 'string')
      return {
        code: cause.code,
        ...('constraint_name' in cause && typeof cause.constraint_name === 'string'
          ? { constraint: cause.constraint_name }
          : {}),
      };
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return {};
}

const unique = (ids: readonly string[]) => [...new Set(ids)];

/** What changed in a replaced set, by name, for the audit entry. */
export interface SetChange {
  before: string[];
  after: string[];
}

// ---------------------------------------------------------------- classes

export async function listClasses(options: { includeRetired: boolean }): Promise<ClassRow[]> {
  const organizationId = await getDefaultOrganizationId();
  return db
    .select()
    .from(schema.dataClass)
    .where(
      and(
        eq(schema.dataClass.organizationId, organizationId),
        options.includeRetired ? undefined : isNull(schema.dataClass.retiredAt),
      ),
    )
    .orderBy(sql`lower(${schema.dataClass.name})`, asc(schema.dataClass.id));
}

export function toDataClass(row: Pick<ClassRow, 'id' | 'name'>): DataClass {
  return { id: row.id, name: row.name };
}

/** Every class with how many models, connectors, projects and conversations use it. */
export async function listAdminClasses(): Promise<AdminDataClass[]> {
  const organizationId = await getDefaultOrganizationId();
  const rows = (await db.execute(sql`
    select c.id, c.name, c.description, c.retired_at, c.created_at, c.updated_at,
      (select count(*)::int from model_data_class x where x.data_class_id = c.id) as model_count,
      (select count(*)::int from connector_data_class x where x.data_class_id = c.id) as connector_count,
      (select count(*)::int from project_data_class x where x.data_class_id = c.id) as project_count,
      (select count(distinct x.thread_id)::int from thread_data_class x where x.data_class_id = c.id) as thread_count
    from data_class c
    where c.organization_id = ${organizationId}
    order by lower(c.name), c.id`)) as unknown as Array<{
    id: string;
    name: string;
    description: string;
    retired_at: string | Date | null;
    created_at: string | Date;
    updated_at: string | Date;
    model_count: number;
    connector_count: number;
    project_count: number;
    thread_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
    modelCount: row.model_count,
    connectorCount: row.connector_count,
    projectCount: row.project_count,
    threadCount: row.thread_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function getClass(id: string): Promise<ClassRow> {
  const [row] = await db.select().from(schema.dataClass).where(eq(schema.dataClass.id, id));
  if (!row) throw notFound('Data class not found');
  return row;
}

function nameTaken(error: unknown): never {
  if (pgError(error).constraint === 'data_class_name_unique')
    throw conflict('A data class with that name already exists.', [
      { path: ['name'], message: 'A data class with that name already exists.' },
    ]);
  throw error;
}

export async function createClass(input: { name: string; description: string }) {
  const organizationId = await getDefaultOrganizationId();
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(schema.dataClass)
    .where(eq(schema.dataClass.organizationId, organizationId));
  if (total >= MAX_DATA_CLASSES)
    throw validationFailed(`An instance can define at most ${MAX_DATA_CLASSES} data classes.`);
  try {
    const [created] = await db
      .insert(schema.dataClass)
      .values({ organizationId, name: input.name, description: input.description })
      .returning();
    return created!;
  } catch (error) {
    return nameTaken(error);
  }
}

/** Renames or re-describes a class. Its id is stable, so every label and approval follows. */
export async function updateClass(
  id: string,
  patch: { name?: string | undefined; description?: string | undefined },
) {
  const before = await getClass(id);
  try {
    const [after] = await db
      .update(schema.dataClass)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
      })
      .where(eq(schema.dataClass.id, id))
      .returning();
    return { before, after: after! };
  } catch (error) {
    return nameTaken(error);
  }
}

/** Hides a class from pickers and refuses new labels. What it labels and approves still counts. */
export async function retireClass(id: string) {
  const before = await getClass(id);
  if (before.retiredAt) return { class: before, changed: false };
  const [after] = await db
    .update(schema.dataClass)
    .set({ retiredAt: new Date() })
    .where(and(eq(schema.dataClass.id, id), isNull(schema.dataClass.retiredAt)))
    .returning();
  return { class: after ?? before, changed: Boolean(after) };
}

async function usageOf(id: string) {
  const [row] = (await db.execute(sql`select
    (select count(*)::int from connector_data_class where data_class_id = ${id}) as connectors,
    (select count(*)::int from project_data_class where data_class_id = ${id}) as projects,
    (select count(distinct thread_id)::int from thread_data_class where data_class_id = ${id}) as threads`)) as unknown as Array<{
    connectors: number;
    projects: number;
    threads: number;
  }>;
  return row!;
}

/**
 * Deletes a class nothing refers to (409 with counts otherwise, from the
 * `restrict` keys). Approvals go with it. There is deliberately no force:
 * it would unlabel content silently.
 */
export async function deleteClass(id: string): Promise<ClassRow> {
  const row = await getClass(id);
  const inUse = (usage: Awaited<ReturnType<typeof usageOf>>) =>
    conflict(
      'This class is still used by connectors, projects or conversations. Remove those labels first.',
      usage,
    );
  const usage = await usageOf(id);
  if (usage.connectors + usage.projects + usage.threads > 0) throw inUse(usage);
  try {
    await db.delete(schema.dataClass).where(eq(schema.dataClass.id, id));
  } catch (error) {
    // A label was added between the count and the delete: the keys refused.
    if (pgError(error).code === '23503') throw inUse(await usageOf(id));
    throw error;
  }
  return row;
}

/**
 * Locks the named classes against deletion while a label is written, and
 * checks they exist. A retired class may stay where it already is but is
 * never newly added (`alreadyThere`).
 */
async function lockClasses(
  tx: Executor,
  classIds: readonly string[],
  alreadyThere: ReadonlySet<string> = new Set(),
): Promise<ClassRow[]> {
  if (classIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(schema.dataClass)
    .where(inArray(schema.dataClass.id, [...classIds]))
    .for('share');
  if (rows.length !== classIds.length)
    throw validationFailed('One of those data classes does not exist.');
  const retired = rows.find((row) => row.retiredAt && !alreadyThere.has(row.id));
  if (retired)
    throw validationFailed(`${retired.name} is retired and cannot be added to anything new.`);
  return rows;
}

/** Class names for an audit entry, in order. */
export async function namesOf(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: schema.dataClass.name })
    .from(schema.dataClass)
    .where(inArray(schema.dataClass.id, [...ids]));
  return rows.map((row) => row.name).sort();
}

// ---------------------------------------------------------------- approvals

/** Replaces the classes a model is approved for. */
export async function setModelClasses(modelId: string, classIds: readonly string[]) {
  const wanted = unique(classIds);
  return db.transaction(async (tx) => {
    const [model] = await tx
      .select({ id: schema.model.id, slug: schema.model.slug })
      .from(schema.model)
      .where(eq(schema.model.id, modelId))
      .for('update');
    if (!model) throw notFound('Model not found');
    const existing = (
      await tx
        .select({ id: schema.modelDataClass.dataClassId })
        .from(schema.modelDataClass)
        .where(eq(schema.modelDataClass.modelId, modelId))
    ).map((row) => row.id);
    await lockClasses(tx, wanted, new Set(existing));
    const add = wanted.filter((id) => !existing.includes(id));
    const remove = existing.filter((id) => !wanted.includes(id));
    if (add.length)
      await tx
        .insert(schema.modelDataClass)
        .values(add.map((dataClassId) => ({ modelId, dataClassId })))
        .onConflictDoNothing();
    if (remove.length)
      await tx
        .delete(schema.modelDataClass)
        .where(
          and(
            eq(schema.modelDataClass.modelId, modelId),
            inArray(schema.modelDataClass.dataClassId, remove),
          ),
        );
    return { slug: model.slug, before: existing, after: wanted };
  });
}

/** Class ids per model, for the admin model list. */
export async function modelClassIds(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ modelId: schema.modelDataClass.modelId, id: schema.modelDataClass.dataClassId })
    .from(schema.modelDataClass);
  const byModel = new Map<string, string[]>();
  for (const row of rows) byModel.set(row.modelId, [...(byModel.get(row.modelId) ?? []), row.id]);
  return byModel;
}

/** Replaces what a connector carries, and records that someone reviewed it. */
export async function setConnectorClasses(
  connectorId: string,
  classIds: readonly string[],
  reviewed: boolean,
) {
  const wanted = unique(classIds);
  return db.transaction(async (tx) => {
    const [connector] = await tx
      .select({ id: schema.connector.id, slug: schema.connector.slug })
      .from(schema.connector)
      .where(eq(schema.connector.id, connectorId))
      .for('update');
    if (!connector) throw notFound('Connector not found');
    const existing = (
      await tx
        .select({ id: schema.connectorDataClass.dataClassId })
        .from(schema.connectorDataClass)
        .where(eq(schema.connectorDataClass.connectorId, connectorId))
    ).map((row) => row.id);
    await lockClasses(tx, wanted, new Set(existing));
    const add = wanted.filter((id) => !existing.includes(id));
    const remove = existing.filter((id) => !wanted.includes(id));
    if (add.length)
      await tx
        .insert(schema.connectorDataClass)
        .values(add.map((dataClassId) => ({ connectorId, dataClassId })))
        .onConflictDoNothing();
    if (remove.length)
      await tx
        .delete(schema.connectorDataClass)
        .where(
          and(
            eq(schema.connectorDataClass.connectorId, connectorId),
            inArray(schema.connectorDataClass.dataClassId, remove),
          ),
        );
    // A connector that carries a class has been looked at; "carries nothing"
    // is a statement only `reviewed: true` makes.
    const isReviewed = reviewed || wanted.length > 0;
    await tx
      .update(schema.connector)
      .set({ dataClassesReviewedAt: isReviewed ? new Date() : null })
      .where(eq(schema.connector.id, connectorId));
    return { slug: connector.slug, before: existing, after: wanted, reviewed: isReviewed };
  });
}

/** Class ids and review state per connector, for the admin connector list. */
export async function connectorClassIds(
  connectorIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byConnector = new Map<string, string[]>();
  if (connectorIds.length === 0) return byConnector;
  const rows = await db
    .select({
      connectorId: schema.connectorDataClass.connectorId,
      id: schema.connectorDataClass.dataClassId,
    })
    .from(schema.connectorDataClass)
    .where(inArray(schema.connectorDataClass.connectorId, [...connectorIds]));
  for (const row of rows)
    byConnector.set(row.connectorId, [...(byConnector.get(row.connectorId) ?? []), row.id]);
  return byConnector;
}

/** Connectors an administrator has not said anything about yet. */
export async function unreviewedConnectorCount(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(schema.connector)
    .where(isNull(schema.connector.dataClassesReviewedAt));
  return row?.total ?? 0;
}

/** Class ids the given connectors carry, all together (the tool about to run). */
export async function classIdsOfConnectors(connectorIds: readonly string[]): Promise<string[]> {
  const byConnector = await connectorClassIds(connectorIds);
  return unique([...byConnector.values()].flat());
}

/** Writes the sticky fact before a connector tool runs, so a crash after the call still leaves the label. */
export async function recordConnectorUse(threadId: string, connectorId: string): Promise<void> {
  await db
    .insert(schema.threadConnectorUse)
    .values({ threadId, connectorId })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------- projects

/**
 * Sets a project's labels. The owner replaces the labels that are not locked
 * (an administrator's cannot be removed: 409); an administrator replaces them
 * all, and every label an administrator sets is locked.
 */
export async function setProjectClasses(
  projectId: string,
  classIds: readonly string[],
  actor: { userId: string; asAdmin: boolean },
) {
  const wanted = unique(classIds);
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: schema.project.id, userId: schema.project.userId })
      .from(schema.project)
      .where(eq(schema.project.id, projectId))
      .for('update');
    if (!project) throw notFound('Project not found');
    // Labelling is the owner's. Somebody who can read the project (a viewer, an editor, a member
    // of a group it is shared with) is told so (403); anybody else gets the 404 a missing project
    // gets, so existence never leaks (requireProjectAccess).
    if (!actor.asAdmin) await requireProjectAccess(projectId, actor.userId, 'owner', tx);
    const rows = await tx
      .select()
      .from(schema.projectDataClass)
      .where(eq(schema.projectDataClass.projectId, projectId));
    const existing = rows.map((row) => row.dataClassId);
    const lockedNotKept = rows.find((row) => row.locked && !wanted.includes(row.dataClassId));
    if (!actor.asAdmin && lockedNotKept)
      throw conflict(
        'A label set by an administrator cannot be removed. Ask an administrator to change it.',
      );
    await lockClasses(tx, wanted, new Set(existing));
    const remove = existing.filter((id) => !wanted.includes(id));
    if (remove.length)
      await tx
        .delete(schema.projectDataClass)
        .where(
          and(
            eq(schema.projectDataClass.projectId, projectId),
            inArray(schema.projectDataClass.dataClassId, remove),
          ),
        );
    // An administrator's labels are locked, including ones the owner had added.
    const add = wanted.filter((id) => actor.asAdmin || !existing.includes(id));
    if (add.length) {
      const insert = tx.insert(schema.projectDataClass).values(
        add.map((dataClassId) => ({
          projectId,
          dataClassId,
          locked: actor.asAdmin,
          createdBy: actor.userId,
        })),
      );
      await (actor.asAdmin
        ? insert.onConflictDoUpdate({
            target: [schema.projectDataClass.projectId, schema.projectDataClass.dataClassId],
            set: { locked: true },
          })
        : insert.onConflictDoNothing());
    }
    return { ownerId: project.userId, before: existing, after: wanted };
  });
}

/** A person's projects with their labels, for an administrator to set (names are visible to administrators only). */
export async function listUserProjectsWithClasses(userId: string): Promise<AdminUserProject[]> {
  const projects = await db
    .select({ id: schema.project.id, name: schema.project.name })
    .from(schema.project)
    .where(eq(schema.project.userId, userId))
    .orderBy(asc(schema.project.name), asc(schema.project.id));
  if (projects.length === 0) return [];
  const labels = await db
    .select({
      projectId: schema.projectDataClass.projectId,
      id: schema.dataClass.id,
      name: schema.dataClass.name,
      locked: schema.projectDataClass.locked,
    })
    .from(schema.projectDataClass)
    .innerJoin(schema.dataClass, eq(schema.projectDataClass.dataClassId, schema.dataClass.id))
    .where(
      inArray(
        schema.projectDataClass.projectId,
        projects.map((project) => project.id),
      ),
    )
    .orderBy(sql`lower(${schema.dataClass.name})`);
  return projects.map((project) => ({
    ...project,
    classes: labels
      .filter((label) => label.projectId === project.id)
      .map(({ id, name, locked }) => ({ id, name, locked })),
  }));
}

// ---------------------------------------------------------------- threads

/**
 * Adds a label to the person's own conversation. Takes the conversation's row
 * lock, so it serialises with a send claiming it (a send racing the commit may
 * pass once; the next is refused).
 */
export async function addThreadClass(threadId: string, userId: string, classId: string) {
  return db.transaction(async (tx) => {
    await lockChatThread(tx, threadId, userId);
    const [row] = await lockClasses(tx, [classId]);
    const inserted = await tx
      .insert(schema.threadDataClass)
      .values({ threadId, dataClassId: classId, source: 'person', createdBy: userId })
      .onConflictDoNothing()
      .returning({ id: schema.threadDataClass.dataClassId });
    return { name: row!.name, created: inserted.length > 0 };
  });
}

/** Why a label cannot be removed by the person, in words. */
const NOT_REMOVABLE: Record<string, string> = {
  project: 'This label comes from the conversation’s project. Change it in the project.',
  connector:
    'This label comes from a connector the conversation used, and stays for as long as the conversation exists.',
  kept: 'This label was kept when a project or connector was removed, and stays for as long as the conversation exists.',
};

/** Removes a label the person added. Labels from a project, a connector or kept ones answer 409. */
export async function removeThreadClass(threadId: string, userId: string, classId: string) {
  return db.transaction(async (tx) => {
    await lockChatThread(tx, threadId, userId);
    const removed = await tx
      .delete(schema.threadDataClass)
      .where(
        and(
          eq(schema.threadDataClass.threadId, threadId),
          eq(schema.threadDataClass.dataClassId, classId),
          eq(schema.threadDataClass.source, 'person'),
        ),
      )
      .returning({ id: schema.threadDataClass.dataClassId });
    if (removed.length > 0) {
      const [row] = await tx
        .select({ name: schema.dataClass.name })
        .from(schema.dataClass)
        .where(eq(schema.dataClass.id, classId));
      return { name: row?.name ?? '' };
    }
    const carried = (await loadClasses({ threadId })).find((entry) => entry.id === classId);
    const reason = carried?.reasons.find((candidate) => candidate in NOT_REMOVABLE);
    if (reason) throw conflict(NOT_REMOVABLE[reason]!);
    throw notFound('That label is not on this conversation');
  });
}
