import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, isNull, lte, schema } from '@oci/db';
import { COMPLIANCE_EXPORT_FORMAT } from '@oci/shared';
import { db } from '../../db/index.js';
import { errorText } from '../../lib/log-redaction.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { recordAudit } from '../audit.js';
import type { BackupTarget } from '../backups/settings.js';
import { manualRunConflict, requestManualRun } from '../jobs/requests.js';
import { runExclusively } from '../jobs/runner.js';
import { withSpan } from '../observability/tracing.js';
import { getDefaultOrganizationId } from '../organization.js';
import { advanceCursor, committedWatermark, exportCursor } from './cursor.js';
import {
  auditLines,
  messageLines,
  newTotals,
  type StreamPlan,
  streamSummary,
} from './export-lines.js';
import { ComplianceExportError, runFolder, verifyObject } from './export-objects.js';
import { complianceSlot, DAY_MS, slotCovered } from './export-schedule.js';
import type { RunRow } from './export-status.js';
import {
  complianceKeyPrefix,
  complianceSettings,
  type ResolvedComplianceSettings,
  resolveComplianceTarget,
} from './settings.js';

export { complianceSlot } from './export-schedule.js';
export { complianceStatus } from './export-status.js';

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

type Actor = { id: string; email: string } | null;

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
      error instanceof ComplianceExportError ? error.message : `Export failed: ${errorText(error)}`
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
