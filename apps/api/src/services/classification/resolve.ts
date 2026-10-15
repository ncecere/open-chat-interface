import { sql, THREAD_CONNECTOR_USE } from '@oci/db';
import {
  CLASSIFICATION_REASONS,
  type ClassificationMode,
  type ClassificationReason,
  type ClassificationService,
  type ClassificationSettings,
  isToolPart,
  toolIdOfPart,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { isBackgroundMigrationDone } from '../migrations/readiness.js';
import { classificationSettings } from './config.js';

/** The background migration that finds connector use from before 0052 (packages/db). */
export const THREAD_CONNECTOR_USE_MIGRATION = THREAD_CONNECTOR_USE;

/** Where the content would go. */
export type Destination =
  | { kind: 'model'; slug: string }
  | { kind: 'service'; name: ClassificationService }
  | { kind: 'share' };

/** A class a conversation (or project) carries, and why. */
export interface ResolvedClass {
  id: string;
  name: string;
  /** Retired classes still count. */
  retired: boolean;
  reasons: ClassificationReason[];
  /** Connectors that give the class (names, for "from the SIS connector"). */
  connectorNames: string[];
  /** Where a kept label came from. */
  origins: string[];
  /** A project label an administrator locked. */
  locked: boolean;
}

export type Outcome = 'allow' | 'warn' | 'block';

export interface Decision {
  mode: ClassificationMode;
  outcome: Outcome;
  /** Everything the conversation carries. */
  classes: ResolvedClass[];
  /** What the destination is not approved for. */
  missing: ResolvedClass[];
}

export interface ClassificationInput {
  /** The conversation. Its project, connector use and labels all count. */
  threadId?: string;
  /** Without a conversation: a project's own labels (file embedding, the picker on a project). */
  projectId?: string;
  destination: Destination;
  /**
   * Classes about to enter the conversation, such as those of the connector
   * whose tool is about to run: the call is judged as if it had already happened.
   */
  extraClassIds?: readonly string[];
}

/** What a mode `off` decision looks like: nothing was read, nothing is carried. */
const OFF: Decision = { mode: 'off', outcome: 'allow', classes: [], missing: [] };

/**
 * The decision for a set of classes and what the destination is approved for.
 * Pure, so the table of cases can be tested without a database. No classes
 * (or all approved) allows; otherwise `block` blocks and `warn` warns.
 */
export function decide(
  mode: ClassificationMode,
  classes: ResolvedClass[],
  approved: ReadonlySet<string>,
): Decision {
  if (mode === 'off') return OFF;
  const missing = classes.filter((entry) => !approved.has(entry.id));
  const outcome: Outcome = missing.length === 0 ? 'allow' : mode === 'block' ? 'block' : 'warn';
  return { mode, outcome, classes, missing };
}

interface ClassRow {
  thread_id: string | null;
  class_id: string;
  name: string;
  retired: boolean;
  reason: string;
  detail: string;
  locked: boolean;
}

const ids = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/**
 * Every label source in one query. Each branch yields (thread, class, reason,
 * detail, locked); the class row supplies the name and whether it is retired.
 *
 * - project: the labels of the thread's project (or of `projectId`);
 * - connector: classes of every connector the thread has used, read now;
 * - person / kept: the thread's own label rows;
 * - extras: classes about to enter (a connector tool about to run).
 */
function classQuery(input: {
  threadIds: readonly string[];
  projectId?: string | undefined;
  extraClassIds: readonly string[];
  /** Connector slugs found by scanning one conversation's messages, while the backfill is unfinished. */
  scanned?: { threadId: string; slugs: readonly string[] };
}): ReturnType<typeof sql> {
  const branches: Array<ReturnType<typeof sql>> = [];
  if (input.threadIds.length)
    branches.push(sql`
      select t.id as thread_id, pdc.data_class_id as class_id, 'project' as reason,
             '' as detail, pdc.locked as locked
      from thread t join project_data_class pdc on pdc.project_id = t.project_id
      where t.id in (${ids(input.threadIds)})
      union all
      select u.thread_id, cdc.data_class_id, 'connector', conn.name, false
      from thread_connector_use u
      join connector conn on conn.id = u.connector_id
      join connector_data_class cdc on cdc.connector_id = u.connector_id
      where u.thread_id in (${ids(input.threadIds)})
      union all
      select tdc.thread_id, tdc.data_class_id, tdc.source, tdc.origin, false
      from thread_data_class tdc
      where tdc.thread_id in (${ids(input.threadIds)})`);
  if (input.projectId)
    branches.push(sql`
      select null::text as thread_id, pdc.data_class_id as class_id, 'project' as reason,
             '' as detail, pdc.locked as locked
      from project_data_class pdc where pdc.project_id = ${input.projectId}`);
  if (input.scanned?.slugs.length)
    branches.push(sql`
      select ${input.scanned.threadId}::text as thread_id, cdc.data_class_id as class_id,
             'connector' as reason, conn.name as detail, false as locked
      from connector conn join connector_data_class cdc on cdc.connector_id = conn.id
      where conn.slug in (${ids(input.scanned.slugs)})`);
  for (const classId of input.extraClassIds)
    branches.push(sql`select null::text as thread_id, ${classId}::text as class_id,
      'connector' as reason, '' as detail, false as locked`);
  if (branches.length === 0) return sql`select null::text as thread_id where false`;
  return sql`
    select s.thread_id, c.id as class_id, c.name, c.retired_at is not null as retired,
           s.reason, s.detail, s.locked
    from (${sql.join(branches, sql` union all `)}) s
    join data_class c on c.id = s.class_id`;
}

function groupClasses(rows: readonly ClassRow[]): ResolvedClass[] {
  const byId = new Map<string, ResolvedClass>();
  for (const row of rows) {
    const reason = row.reason as ClassificationReason;
    const entry = byId.get(row.class_id) ?? {
      id: row.class_id,
      name: row.name,
      retired: row.retired,
      reasons: [],
      connectorNames: [],
      origins: [],
      locked: false,
    };
    byId.set(row.class_id, entry);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (reason === 'connector' && row.detail && !entry.connectorNames.includes(row.detail))
      entry.connectorNames.push(row.detail);
    if (reason === 'kept' && row.detail && !entry.origins.includes(row.detail))
      entry.origins.push(row.detail);
    if (reason === 'project' && row.locked) entry.locked = true;
  }
  // Names are unique ignoring case (a unique index), so this order is total.
  return [...byId.values()]
    .map((entry) => ({
      ...entry,
      reasons: CLASSIFICATION_REASONS.filter((reason) => entry.reasons.includes(reason)),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/**
 * Connector slugs a thread's messages used tools of, found in the stored
 * parts. Only while background migration `0.14.thread-connector-use` has not
 * finished: it covers the conversations that used a connector before 0052 (or
 * on a v0.13 replica in the upgrade window) and have no use row yet. Over-
 * counting is the safe direction (a slug reused after a connector was deleted).
 */
async function scanConnectorSlugs(threadId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select parts from message
    where thread_id = ${threadId} and role = 'assistant'
      and jsonb_path_exists(parts, '$[*] ? (@.type starts with "tool-mcp__" || (@.type == "dynamic-tool" && @.toolName starts with "mcp__"))')
  `)) as unknown as Array<{ parts: unknown }>;
  const slugs = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.parts)) continue;
    for (const part of row.parts) {
      if (!isToolPart(part)) continue;
      const toolId = toolIdOfPart(part);
      if (!toolId.startsWith('mcp__')) continue;
      // `mcp__<slug>__<tool>`; an empty slug matches no connector.
      slugs.add(toolId.slice('mcp__'.length).split('__', 1).join(''));
    }
  }
  return [...slugs];
}

/** The classes a conversation (or a project, or about-to-enter extras) carries. */
export async function loadClasses(
  input: Pick<ClassificationInput, 'threadId' | 'projectId' | 'extraClassIds'>,
): Promise<ResolvedClass[]> {
  const scanned =
    input.threadId && !(await isBackgroundMigrationDone(THREAD_CONNECTOR_USE_MIGRATION))
      ? { threadId: input.threadId, slugs: await scanConnectorSlugs(input.threadId) }
      : undefined;
  const rows = (await db.execute(
    classQuery({
      threadIds: input.threadId ? [input.threadId] : [],
      projectId: input.projectId,
      extraClassIds: input.extraClassIds ?? [],
      ...(scanned && { scanned }),
    }),
  )) as unknown as ClassRow[];
  return groupClasses(rows);
}

/**
 * The classes of several conversations, for lists (`ThreadSummary.dataClasses`).
 * One query; the connector-use scan is not repeated per conversation (a list
 * during the upgrade gap may miss a use that only the scan would find; the
 * decision itself, which always uses `loadClasses`, does not).
 */
export async function loadClassesForThreads(
  threadIds: readonly string[],
): Promise<Map<string, ResolvedClass[]>> {
  const result = new Map<string, ResolvedClass[]>();
  if (threadIds.length === 0) return result;
  const rows = (await db.execute(
    classQuery({ threadIds, extraClassIds: [] }),
  )) as unknown as ClassRow[];
  const byThread = new Map<string, ClassRow[]>();
  // Every row of a thread query names its thread.
  for (const row of rows) {
    const threadId = row.thread_id as string;
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), row]);
  }
  for (const [threadId, threadRows] of byThread) result.set(threadId, groupClasses(threadRows));
  return result;
}

/** Class ids a model slug is approved for. A slug with no model row is approved for nothing. */
export async function approvedForModel(slug: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    select mdc.data_class_id as id
    from model_data_class mdc join model m on m.id = mdc.model_id
    where m.slug = ${slug}`)) as unknown as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

async function approvedFor(
  destination: Destination,
  settings: ClassificationSettings,
): Promise<Set<string>> {
  if (destination.kind === 'model') return approvedForModel(destination.slug);
  // A share link is never approved: anyone with the link can read the conversation.
  if (destination.kind === 'share') return new Set();
  return new Set(settings.services[destination.name]);
}

/**
 * The one question every enforcement point asks: may what this conversation
 * carries go to this destination?
 *
 * Mode `off` answers `allow` after one cached setting read and nothing else.
 * In `block` a failure to read refuses (the error propagates, so a failover is
 * retried by the caller's step first); in `warn` a failure allows and is
 * logged, as `warn` never refuses anything.
 */
export async function resolveClassification(input: ClassificationInput): Promise<Decision> {
  const settings = await classificationSettings();
  if (settings.mode === 'off') return OFF;
  try {
    const classes = await loadClasses(input);
    // Nothing carried: nothing to approve, no further query.
    if (classes.length === 0) return decide(settings.mode, classes, new Set());
    return decide(settings.mode, classes, await approvedFor(input.destination, settings));
  } catch (error) {
    if (settings.mode === 'block') throw error;
    logger.warn({ error }, 'Could not read data classes; warn mode allows');
    return { mode: settings.mode, outcome: 'allow', classes: [], missing: [] };
  }
}
