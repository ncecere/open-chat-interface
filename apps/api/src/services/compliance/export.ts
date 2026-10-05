import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, gt, gte, isNull, lte, or, schema, sql } from '@oci/db';
import { COMPLIANCE_EXPORT_FORMAT, type ComplianceRun, type ComplianceStatus } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { recordAudit } from '../audit.js';
import type { BackupTarget } from '../backups/settings.js';
import { manualRunConflict, requestManualRun } from '../jobs/requests.js';
import { runExclusively } from '../jobs/runner.js';
import { withSpan } from '../observability/tracing.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';
import { summarizeMessageParts } from './content.js';
import { advanceCursor, committedWatermark, exportCursor } from './cursor.js';
import { listLegalHolds } from './holds.js';
import {
  complianceConfigurationIssues,
  complianceKeyPrefix,
  complianceSettings,
  type ResolvedComplianceSettings,
  resolveComplianceTarget,
  toPublicComplianceSettings,
} from './settings.js';

/**
 * Compliance export: audit events and, when an administrator turns it on,
 * conversation content, written as JSON Lines to S3-compatible storage by the
 * job runner. See docs/admin/compliance.md.
 *
 * Exactly once per event. Each stream has a cursor (the last exported
 * sequence number). A run reads a committed upper bound (`committedWatermark`),
 * writes every row between the cursor and that bound, reads every object back
 * and checks it, and only then moves the cursor, in the same transaction that
 * marks the run succeeded. A run that fails or is interrupted leaves the
 * cursor where it was and deletes what it wrote, so the next run writes the
 * same events again without leaving a second copy behind. Object keys are
 * recorded before anything is uploaded, which is what lets a run interrupted
 * by a restart be found and cleaned up.
 */

export const COMPLIANCE_JOB = 'compliance.export';

type RunRow = typeof schema.complianceExportRun.$inferSelect;
type Actor = { id: string; email: string } | null;

const PAGE = 500;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** A failure explained in words fit for the run history. */
class ComplianceExportError extends Error {}

interface StreamTotals {
  count: number;
  bytes: number;
  firstSeq: number | null;
  lastSeq: number | null;
  firstId: string | null;
  lastId: string | null;
  hash: ReturnType<typeof createHash>;
}

const newTotals = (): StreamTotals => ({
  count: 0,
  bytes: 0,
  firstSeq: null,
  lastSeq: null,
  firstId: null,
  lastId: null,
  hash: createHash('sha256'),
});

function encodeLines(
  rows: Array<{ seq: number; id: string; line: Record<string, unknown> }>,
  totals: StreamTotals,
): Uint8Array {
  const body = Buffer.from(rows.map((row) => `${JSON.stringify(row.line)}\n`).join(''), 'utf8');
  for (const row of rows) {
    totals.count += 1;
    totals.firstSeq ??= row.seq;
    totals.firstId ??= row.id;
    totals.lastSeq = row.seq;
    totals.lastId = row.id;
  }
  totals.bytes += body.byteLength;
  totals.hash.update(body);
  return body;
}

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

/** One line per audit entry with a sequence number in (after, through], in order. */
async function* auditLines(
  after: number,
  through: number,
  totals: StreamTotals,
): AsyncGenerator<Uint8Array> {
  let cursor = after;
  while (cursor < through) {
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(gt(schema.auditLog.seq, cursor), lte(schema.auditLog.seq, through)))
      .orderBy(asc(schema.auditLog.seq))
      .limit(PAGE);
    if (rows.length === 0) return;
    cursor = Number(rows.at(-1)!.seq);
    yield encodeLines(
      rows.map((row) => ({
        seq: Number(row.seq),
        id: row.id,
        line: {
          seq: Number(row.seq),
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          action: row.action,
          actorUserId: row.actorUserId,
          actorEmail: row.actorEmail,
          targetType: row.targetType,
          targetId: row.targetId,
          metadata: row.metadata ?? null,
          ipAddress: row.ipAddress,
        },
      })),
      totals,
    );
  }
}

interface MessageRow extends Record<string, unknown> {
  seq: string | number;
  id: string;
  thread_id: string;
  user_id: string;
  user_email: string | null;
  role: string;
  parts: unknown;
  status: string;
  model_slug: string | null;
  parent_message_id: string | null;
  superseded_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  thread_title: string;
  thread_temporary: boolean;
  thread_project_id: string | null;
}

/**
 * One line per message whose change sequence number is in (after, through].
 * A message still streaming is skipped: finishing it changes its status and
 * gives it a new number, so it is exported once, complete.
 */
async function* messageLines(
  after: number,
  through: number,
  totals: StreamTotals,
): AsyncGenerator<Uint8Array> {
  let cursor = after;
  while (cursor < through) {
    const rows = await db.execute<MessageRow>(sql`
      select m.change_seq as seq, m.id, m.thread_id, m.user_id, u.email as user_email,
        m.role, m.parts, m.status, m.model_slug, m.parent_message_id, m.superseded_at,
        m.error_message, m.created_at, m.updated_at,
        t.title as thread_title, t.temporary as thread_temporary, t.project_id as thread_project_id
      from ${schema.message} m
      join ${schema.thread} t on t.id = m.thread_id
      left join ${schema.user} u on u.id = m.user_id
      where m.change_seq > ${cursor} and m.change_seq <= ${through}
      order by m.change_seq
      limit ${PAGE}
    `);
    if (rows.length === 0) return;
    cursor = Number(rows.at(-1)!.seq);
    const complete = rows.filter((row) => row.status !== 'streaming');
    if (complete.length === 0) continue;
    yield encodeLines(
      complete.map((row) => {
        const content = summarizeMessageParts(row.parts);
        return {
          seq: Number(row.seq),
          id: row.id,
          line: {
            seq: Number(row.seq),
            id: row.id,
            threadId: row.thread_id,
            userId: row.user_id,
            userEmail: row.user_email,
            role: row.role,
            status: row.status,
            model: row.model_slug,
            parentMessageId: row.parent_message_id,
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
            supersededAt: iso(row.superseded_at),
            error: row.error_message,
            thread: {
              title: row.thread_title,
              temporary: row.thread_temporary,
              projectId: row.thread_project_id,
            },
            ...content,
          },
        };
      }),
      totals,
    );
  }
}

async function readObject(target: BackupTarget, key: string): Promise<AsyncIterable<Uint8Array>> {
  return (await target.driver.getStream(key)) as AsyncIterable<Uint8Array>;
}

/** Reads an object back: its size, SHA-256 and line count must be what was written. */
async function verifyObject(
  target: BackupTarget,
  key: string,
  expected: { bytes: number; sha256: string; lines: number | null },
): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  for await (const chunk of await readObject(target, key)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 0x0a) lines += 1;
  }
  if (
    bytes !== expected.bytes ||
    hash.digest('hex') !== expected.sha256 ||
    (expected.lines !== null && lines !== expected.lines)
  )
    throw new ComplianceExportError(
      `Verification failed: the stored ${key.split('/').at(-1)} does not match what was written.`,
    );
}

/** Deletes objects; true when every one is gone. */
async function deleteObjects(target: BackupTarget, keys: Array<string | null>): Promise<boolean> {
  let ok = true;
  for (const key of keys) {
    if (!key) continue;
    try {
      await target.driver.delete(key);
    } catch {
      ok = false;
    }
  }
  return ok;
}

const keysOf = (run: RunRow) => [run.auditKey, run.messagesKey, run.manifestKey];

/**
 * Deletes the objects of runs that never finished (the process stopped) or
 * failed before their objects could be removed. Called under the job lock,
 * so a `running` row here belongs to no live process.
 */
async function cleanUpUnfinishedRuns(): Promise<void> {
  await db
    .update(schema.complianceExportRun)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errorMessage: 'Interrupted before finishing; its objects were discarded.',
      cleanupPending: true,
    })
    .where(eq(schema.complianceExportRun.status, 'running'));

  const pending = await db
    .select()
    .from(schema.complianceExportRun)
    .where(eq(schema.complianceExportRun.cleanupPending, true))
    .limit(50);
  for (const run of pending) {
    // A destination since changed is resolved from the run's own record where possible.
    let target: BackupTarget;
    try {
      target = await targetForRun(run);
    } catch {
      continue;
    }
    if (await deleteObjects(target, keysOf(run)))
      await db
        .update(schema.complianceExportRun)
        .set({ cleanupPending: false })
        .where(eq(schema.complianceExportRun.id, run.id));
  }
}

/** The destination a run wrote to, when it is still the configured one. */
async function targetForRun(run: RunRow): Promise<BackupTarget> {
  const settings = await complianceSettings();
  if (run.destination !== settings.destination || run.keyPrefix !== complianceKeyPrefix(settings))
    throw new Error('The destination has changed since this run.');
  return resolveComplianceTarget(settings);
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

/** `<prefix>YYYY/MM/DD/<start time>-<run id>/`: one folder per run, sorted by time. */
function runFolder(root: string, startedAt: Date, runId: string): string {
  const day = startedAt.toISOString().slice(0, 10).replace(/-/g, '/');
  return `${root}${day}/${stamp(startedAt)}-${runId.slice(0, 8)}/`;
}

interface StreamPlan {
  after: number;
  through: number;
}

function streamSummary(plan: StreamPlan, key: string | null, totals: StreamTotals) {
  return {
    key,
    afterSeq: plan.after,
    throughSeq: plan.through,
    count: totals.count,
    firstSeq: totals.firstSeq,
    lastSeq: totals.lastSeq,
    firstId: totals.firstId,
    lastId: totals.lastId,
    bytes: totals.bytes,
    sha256: key ? totals.hash.copy().digest('hex') : null,
  };
}

/**
 * Runs one export now. Records the run and rethrows a failure so the job run
 * is marked failed too. Callers hold the export job lock.
 */
export async function performComplianceExport(options: {
  trigger: 'schedule' | 'manual';
  actor?: Actor;
  /** How long to wait for writers when reading the committed upper bound. */
  lockTimeoutMs?: number;
  lockAttempts?: number;
}): Promise<RunRow> {
  const settings = await complianceSettings();
  await cleanUpUnfinishedRuns();
  const startedAt = new Date();
  const runId = randomUUID();
  await db.insert(schema.complianceExportRun).values({
    id: runId,
    organizationId: await getDefaultOrganizationId(),
    trigger: options.trigger,
    startedAt,
    destination: settings.destination,
    keyPrefix: complianceKeyPrefix(settings),
    includeContent: settings.includeContent,
  });
  // Held in an object so the failure path sees what the run got to.
  const written: { target: BackupTarget | null; keys: Array<string | null> } = {
    target: null,
    keys: [],
  };

  try {
    return await withSpan(
      'compliance.export',
      { 'oci.compliance.trigger': options.trigger },
      async () => {
        const target = await resolveComplianceTarget(settings);
        written.target = target;
        const lock = { lockTimeoutMs: options.lockTimeoutMs, attempts: options.lockAttempts };

        const audit: StreamPlan = {
          after: (await exportCursor('audit')) ?? 0,
          through: await committedWatermark('audit', lock),
        };
        let messages: StreamPlan | null = null;
        if (settings.includeContent) {
          const through = await committedWatermark('messages', lock);
          // Never started (content turned on without going through the
          // settings page): start from now rather than from v0.9's upgrade.
          messages = { after: (await exportCursor('messages')) ?? through, through };
        }
        // The cursor never moves backwards; a bound below it means nothing new.
        audit.through = Math.max(audit.through, audit.after);
        if (messages) messages.through = Math.max(messages.through, messages.after);

        const hasAudit = audit.through > audit.after;
        const hasMessages = Boolean(messages && messages.through > messages.after);
        const folder = runFolder(target.root, startedAt, runId);
        const auditKey = hasAudit ? `${folder}audit.jsonl` : null;
        const messagesKey = hasMessages ? `${folder}messages.jsonl` : null;
        const manifestKey = hasAudit || hasMessages ? `${folder}manifest.json` : null;
        written.keys = [auditKey, messagesKey, manifestKey];

        // The plan is committed before anything is written, so an interrupted
        // run's objects can be found and removed by the next one.
        await db
          .update(schema.complianceExportRun)
          .set({
            auditKey,
            auditAfterSeq: audit.after,
            auditThroughSeq: audit.through,
            messagesKey,
            messagesAfterSeq: messages?.after ?? null,
            messagesThroughSeq: messages?.through ?? null,
            manifestKey,
          })
          .where(eq(schema.complianceExportRun.id, runId));

        const auditTotals = newTotals();
        const messageTotals = newTotals();
        if (auditKey)
          await target.driver.putStream(
            auditKey,
            auditLines(audit.after, audit.through, auditTotals),
            'application/x-ndjson',
          );
        if (messagesKey && messages)
          await target.driver.putStream(
            messagesKey,
            messageLines(messages.after, messages.through, messageTotals),
            'application/x-ndjson',
          );

        const auditSummary = streamSummary(audit, auditKey, auditTotals);
        const messagesSummary = messages
          ? streamSummary(messages, messagesKey, messageTotals)
          : null;
        let manifestSha256: string | null = null;
        if (manifestKey) {
          const manifest = Buffer.from(
            `${JSON.stringify(
              {
                format: COMPLIANCE_EXPORT_FORMAT,
                ociVersion: APP_VERSION,
                runId,
                trigger: options.trigger,
                createdAt: startedAt.toISOString(),
                contentIncluded: settings.includeContent,
                streams: { audit: auditSummary, messages: messagesSummary },
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
          manifestSha256 = createHash('sha256').update(manifest).digest('hex');
          // Written last: a folder without a manifest is an incomplete run.
          await target.driver.putStream(manifestKey, Readable.from([manifest]), 'application/json');

          if (auditKey)
            await verifyObject(target, auditKey, {
              bytes: auditTotals.bytes,
              sha256: auditSummary.sha256!,
              lines: auditTotals.count,
            });
          if (messagesKey && messagesSummary)
            await verifyObject(target, messagesKey, {
              bytes: messageTotals.bytes,
              sha256: messagesSummary.sha256!,
              lines: messageTotals.count,
            });
          await verifyObject(target, manifestKey, {
            bytes: manifest.byteLength,
            sha256: manifestSha256,
            lines: null,
          });
        }

        // Cursors and the run's success commit together, or not at all.
        const finished = await db.transaction(async (tx) => {
          if (!(await advanceCursor(tx, 'audit', audit.after, audit.through, runId)))
            throw new ComplianceExportError(
              'Another export moved the audit cursor during this run.',
            );
          if (
            messages &&
            !(await advanceCursor(tx, 'messages', messages.after, messages.through, runId))
          )
            throw new ComplianceExportError(
              'Another export moved the message cursor during this run.',
            );
          const [row] = await tx
            .update(schema.complianceExportRun)
            .set({
              status: 'succeeded',
              finishedAt: new Date(),
              auditCount: auditTotals.count,
              auditFirstId: auditTotals.firstId,
              auditLastId: auditTotals.lastId,
              auditBytes: auditKey ? auditTotals.bytes : null,
              auditSha256: auditSummary.sha256,
              messageCount: messages ? messageTotals.count : null,
              messagesFirstId: messageTotals.firstId,
              messagesLastId: messageTotals.lastId,
              messagesBytes: messagesKey ? messageTotals.bytes : null,
              messagesSha256: messagesSummary?.sha256 ?? null,
              manifestSha256,
              verified: true,
            })
            .where(eq(schema.complianceExportRun.id, runId))
            .returning();
          return row!;
        });

        logger.info(
          {
            complianceRunId: runId,
            auditEvents: auditTotals.count,
            messages: messageTotals.count,
            durationMs: Date.now() - startedAt.getTime(),
          },
          'Compliance export completed',
        );
        if (options.trigger === 'manual')
          await recordAudit({
            actorUserId: options.actor?.id ?? null,
            actorEmail: options.actor?.email ?? null,
            action: 'compliance.export.run',
            targetType: 'compliance_export',
            targetId: runId,
            metadata: {
              trigger: options.trigger,
              status: 'succeeded',
              auditEvents: auditTotals.count,
              messages: messages ? messageTotals.count : null,
            },
          });

        await pruneComplianceExports(settings, target).catch((error: unknown) =>
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'Compliance export retention failed',
          ),
        );
        return finished;
      },
    );
  } catch (error) {
    const message = (
      error instanceof ComplianceExportError
        ? error.message
        : `Export failed: ${error instanceof Error ? error.message : String(error)}`
    ).slice(0, 1_000);
    const cleaned = written.target ? await deleteObjects(written.target, written.keys) : true;
    await db
      .update(schema.complianceExportRun)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: message,
        cleanupPending: !cleaned,
      })
      .where(eq(schema.complianceExportRun.id, runId));
    logger.error({ complianceRunId: runId, error: message }, 'Compliance export failed');
    await recordAudit({
      actorUserId: options.actor?.id ?? null,
      actorEmail: options.actor?.email ?? null,
      action: 'compliance.export.run',
      targetType: 'compliance_export',
      targetId: runId,
      metadata: { trigger: options.trigger, status: 'failed', error: message.slice(0, 300) },
    });
    throw new Error(message);
  }
}

/**
 * Deletes the objects of successful runs older than `keepDays`, when set.
 * Only runs written to the current destination are considered. Cursors are
 * not affected: deleting old objects never makes events export again.
 */
export async function pruneComplianceExports(
  settings: ResolvedComplianceSettings,
  target?: BackupTarget,
  now = new Date(),
): Promise<number> {
  if (settings.keepDays === null) return 0;
  const resolved = target ?? (await resolveComplianceTarget(settings));
  const cutoff = new Date(now.getTime() - settings.keepDays * DAY_MS);
  const runs = await db
    .select()
    .from(schema.complianceExportRun)
    .where(
      and(
        eq(schema.complianceExportRun.status, 'succeeded'),
        isNull(schema.complianceExportRun.prunedAt),
        eq(schema.complianceExportRun.destination, settings.destination),
        eq(schema.complianceExportRun.keyPrefix, resolved.root),
        lte(schema.complianceExportRun.startedAt, cutoff),
      ),
    )
    .limit(500);
  let pruned = 0;
  for (const run of runs) {
    if (!(await deleteObjects(resolved, keysOf(run)))) continue;
    await db
      .update(schema.complianceExportRun)
      .set({ prunedAt: new Date() })
      .where(eq(schema.complianceExportRun.id, run.id));
    pruned += 1;
  }
  return pruned;
}

/** The most recent scheduled start at or before `now`: the hour, or today's hour (UTC). */
export function complianceSlot(now: Date, schedule: 'hourly' | 'daily', hourUtc: number): Date {
  if (schedule === 'hourly') {
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    return slot;
  }
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0),
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

/**
 * Whether the current slot is covered: a successful export since it began, or
 * a scheduled attempt in the last hour (so a failure is retried hourly
 * rather than on every tick).
 */
async function slotCovered(slot: Date, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.complianceExportRun.id })
    .from(schema.complianceExportRun)
    .where(
      and(
        gte(schema.complianceExportRun.startedAt, slot),
        or(
          eq(schema.complianceExportRun.status, 'succeeded'),
          and(
            eq(schema.complianceExportRun.trigger, 'schedule'),
            gt(schema.complianceExportRun.startedAt, new Date(now.getTime() - HOUR_MS)),
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The job: exports when on and the current slot is not yet covered. */
export async function runScheduledComplianceExport(now = new Date()): Promise<number> {
  const settings = await complianceSettings();
  if (!settings.enabled) {
    // Still tidy up after a run a restart interrupted, so "Run now" is not blocked.
    await cleanUpUnfinishedRuns();
    return 0;
  }
  if (await slotCovered(complianceSlot(now, settings.schedule, settings.hourUtc), now)) return 0;
  const run = await performComplianceExport({ trigger: 'schedule' });
  return (run.auditCount ?? 0) + (run.messageCount ?? 0);
}

/** A manual export under the job lock. Null if one was already running. */
async function runManualComplianceExport(actor: Actor): Promise<number | null> {
  return runExclusively({
    name: COMPLIANCE_JOB,
    intervalMs: 0,
    run: () =>
      performComplianceExport({ trigger: 'manual', actor }).then(
        (run) => (run.auditCount ?? 0) + (run.messageCount ?? 0),
      ),
  });
}

/** Starts a manual export in the background. */
export async function startManualComplianceExport(actor: Actor): Promise<'started' | 'running'> {
  const [running] = await db
    .select({ id: schema.complianceExportRun.id })
    .from(schema.complianceExportRun)
    .where(eq(schema.complianceExportRun.status, 'running'))
    .limit(1);
  if (running) return 'running';
  // On a `web` replica (v0.11) a worker runs it.
  const placed = await requestManualRun({ job: COMPLIANCE_JOB, actor: actor ?? undefined });
  if (placed === 'no-worker') throw manualRunConflict();
  if (placed === 'queued') return 'started';
  void runManualComplianceExport(actor).catch((error: unknown) =>
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Manual compliance export failed',
    ),
  );
  return 'started';
}

const num = (value: number | string | null) => (value === null ? null : Number(value));

function toComplianceRunView(row: RunRow): ComplianceRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    destination: row.destination,
    includeContent: row.includeContent,
    audit: {
      key: row.auditKey,
      afterSeq: num(row.auditAfterSeq),
      throughSeq: num(row.auditThroughSeq),
      count: row.auditCount,
      bytes: num(row.auditBytes),
      sha256: row.auditSha256,
    },
    messages: row.includeContent
      ? {
          key: row.messagesKey,
          afterSeq: num(row.messagesAfterSeq),
          throughSeq: num(row.messagesThroughSeq),
          count: row.messageCount,
          bytes: num(row.messagesBytes),
          sha256: row.messagesSha256,
        }
      : null,
    manifestKey: row.manifestKey,
    verified: row.verified,
    errorMessage: row.errorMessage,
    prunedAt: row.prunedAt?.toISOString() ?? null,
  };
}

async function recentComplianceRuns(limit = 20): Promise<RunRow[]> {
  return db
    .select()
    .from(schema.complianceExportRun)
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(limit);
}

async function lastSuccessfulComplianceRun(): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(schema.complianceExportRun)
    .where(eq(schema.complianceExportRun.status, 'succeeded'))
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(1);
  return row ?? null;
}

/** Everything the Compliance page shows. */
export async function complianceStatus(now = new Date()): Promise<ComplianceStatus> {
  const settings = await complianceSettings();
  const [issues, runs, lastSuccess, storage, auditCursor, messagesCursor, holds] =
    await Promise.all([
      complianceConfigurationIssues(settings),
      recentComplianceRuns(20),
      lastSuccessfulComplianceRun(),
      getSetting('storage'),
      exportCursor('audit'),
      exportCursor('messages'),
      listLegalHolds({ includeLifted: true, limit: 100 }),
    ]);
  let nextRunAt: string | null = null;
  if (settings.enabled) {
    const slot = complianceSlot(now, settings.schedule, settings.hourUtc);
    nextRunAt = (await slotCovered(slot, now))
      ? new Date(slot.getTime() + (settings.schedule === 'hourly' ? HOUR_MS : DAY_MS)).toISOString()
      : now.toISOString();
  }
  return {
    settings: toPublicComplianceSettings(settings),
    issues,
    attachmentStorage: {
      driver: storage.driver,
      bucket: storage.driver === 's3' ? storage.s3.bucket || null : null,
    },
    running: runs.some((run) => run.status === 'running'),
    nextRunAt,
    lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
    cursor: { audit: auditCursor ?? 0, messages: messagesCursor },
    runs: runs.map(toComplianceRunView),
    holds,
  };
}

/** Writes, reads back and deletes a small object at the destination. */
export async function testComplianceTarget(settings: ResolvedComplianceSettings): Promise<void> {
  const target = await resolveComplianceTarget(settings);
  const key = `${target.root}.oci-write-test-${Date.now()}`;
  const body = Buffer.from(`oci compliance destination check ${new Date().toISOString()}`);
  await target.driver.putStream(key, Readable.from([body]), 'text/plain');
  try {
    const stored = await target.driver.get(key);
    if (!stored.equals(body)) throw new Error('The test object did not read back correctly.');
  } finally {
    await target.driver.delete(key).catch(() => undefined);
  }
}
