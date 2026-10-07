import { eq, schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { isSmtpUsable, sendEmail } from './email.js';
import { getSetting } from './settings.js';
import {
  dailyUsage,
  type ModelUsage,
  modelUsage,
  topConsumers,
  usageTotals,
} from './usage-report.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const CADENCE_MS: Record<'daily' | 'weekly' | 'monthly', number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  // Approximate on purpose: a report that lands on the 30th rather than the
  // 1st is fine, and calendar arithmetic here would buy nothing.
  monthly: 30 * DAY_MS,
};

function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * The report body.
 *
 * Plain text rather than HTML: it is read in a mail client, often forwarded,
 * and a table of numbers survives that better than a layout.
 */
/** "1 message", "1,204 messages" (#78: the report said "1 messages"). */
export function messageCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'message' : 'messages'}`;
}

/**
 * One model's line. An embeddings model is named by its model ID, not the
 * internal `embedding:` key, and given its tokens: it sends no messages, so
 * "0 messages" said nothing about it (#263).
 */
export function modelLine(
  model: Pick<
    ModelUsage,
    'modelSlug' | 'displayName' | 'kind' | 'messages' | 'tokens' | 'costMicros'
  >,
): string {
  const name = model.displayName ?? model.modelSlug;
  const cost = formatCost(model.costMicros);
  return model.kind === 'embeddings'
    ? `${name} (embeddings)  ${model.tokens.toLocaleString('en-US')} tokens  ${cost}`
    : `${name}  ${messageCount(model.messages)}  ${cost}`;
}

/** The report's first line: "…usage, last 30 days", or "last 1 day" (#286, as #263). */
export function reportHeading(appName: string, windowDays: number): string {
  return `${appName} usage, last ${windowDays} ${windowDays === 1 ? 'day' : 'days'}`;
}

async function buildUsageReport(windowDays: number, appName: string): Promise<string> {
  const [totals, daily, models, consumers] = await Promise.all([
    usageTotals(windowDays),
    dailyUsage(windowDays),
    modelUsage(windowDays, 10),
    topConsumers(windowDays, 10),
  ]);

  const lines: string[] = [
    reportHeading(appName, windowDays),
    '',
    `Messages:      ${totals.messages.toLocaleString()}`,
    `Tokens:        ${totals.tokens.toLocaleString()}`,
    `Cost:          ${formatCost(totals.costMicros)}`,
    `Active people: ${totals.activeUsers.toLocaleString()}`,
    '',
    'Busiest days',
  ];

  const busiest = [...daily].sort((a, b) => b.messages - a.messages).slice(0, 5);
  for (const day of busiest) {
    lines.push(`  ${day.day}  ${messageCount(day.messages)}`);
  }

  lines.push('', 'Models');
  for (const model of models.entries) {
    lines.push(`  ${modelLine(model)}`);
  }

  lines.push('', 'Heaviest use');
  for (const consumer of consumers.entries) {
    // Deleted accounts are one row, named by the label rather than an address.
    const who = consumer.deleted ? consumer.name : consumer.email;
    lines.push(`  ${who}  ${messageCount(consumer.messages)}`);
  }

  return lines.join('\n');
}

/**
 * A failed send is tried again (#352), after these pauses counted from the
 * last attempt, and then only once a period. Before, a failed attempt was
 * recorded as the report's send, so one SMTP blip lost the whole period (a
 * month, for a monthly report) and nothing tried again. The hourly check
 * notices a retry within the hour after it falls due. The bound keeps a
 * permanently refusing address (or one rejected by a server that still
 * delivered to the others) from being mailed every hour.
 */
export const REPORT_RETRY_PAUSES_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];

type ReportSchedule = {
  enabled: boolean;
  cadence: keyof typeof CADENCE_MS;
  lastRunAt: Date | null;
  lastAttemptAt?: Date | null;
  failedAttempts?: number;
};

/** Failed attempts before the report waits for its next period (#352). */
export function retriesLeft(report: Pick<ReportSchedule, 'failedAttempts'>): number {
  return Math.max(0, REPORT_RETRY_PAUSES_MS.length + 1 - (report.failedAttempts ?? 0));
}

/** When the report is next due, ignoring whether it is enabled (null: never sent, due now). */
function dueAt(report: ReportSchedule): Date | null {
  const periodEnds = report.lastRunAt
    ? report.lastRunAt.getTime() + CADENCE_MS[report.cadence]
    : null;
  const failed = report.failedAttempts ?? 0;
  if (failed === 0 || !report.lastAttemptAt)
    return periodEnds === null ? null : new Date(periodEnds);
  const pause = REPORT_RETRY_PAUSES_MS[failed - 1] ?? CADENCE_MS[report.cadence];
  const retryAt = report.lastAttemptAt.getTime() + pause;
  return new Date(Math.max(periodEnds ?? 0, retryAt));
}

/**
 * When a report is next sent (#85): null while paused; otherwise a cadence
 * after its last send, or `now` when it has never been sent or is already
 * due, which the hourly check picks up within the hour. After a failed
 * attempt, the pause before the next one (#352).
 */
export function nextReportRunAt(report: ReportSchedule, now = new Date()): Date | null {
  if (!report.enabled) return null;
  const at = dueAt(report);
  return at ? new Date(Math.max(at.getTime(), now.getTime())) : now;
}

/** Whether the hourly check sends this report now. */
function isDue(report: ReportSchedule & { recipients: string[] }, now: Date): boolean {
  if (!report.enabled || report.recipients.length === 0) return false;
  const at = dueAt(report);
  return at === null || at.getTime() <= now.getTime();
}

type ReportRow = typeof schema.scheduledReport.$inferSelect;

/** Builds and sends one report; `delivered` false means it was not sent. */
async function sendReport(
  report: ReportRow,
): Promise<{ delivered: true } | { delivered: false; notConfigured: boolean; error: string }> {
  const branding = await getSetting('branding');
  try {
    const body = await buildUsageReport(report.windowDays, branding.appName);

    // sendEmail reports failure by returning a flag rather than throwing, so
    // a bare call here would record every send as a success.
    const result = await sendEmail({
      to: report.recipients.join(', '),
      subject: `${branding.appName}: ${report.name}`,
      text: body,
    });
    if (result.delivered) return { delivered: true };
    return {
      delivered: false,
      notConfigured: Boolean(result.notConfigured),
      error: result.notConfigured ? 'Email delivery is not set up' : 'Email delivery failed',
    };
  } catch (error) {
    // Recorded on the row rather than only logged, so an administrator can
    // see a report has been failing without reading server logs.
    logger.error({ error, reportId: report.id }, 'Scheduled report failed');
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { delivered: false, notConfigured: false, error: message.slice(0, 500) };
  }
}

/**
 * Sends every scheduled report that is due.
 *
 * Due-ness is decided from `lastRunAt`, the last successful send, rather than
 * a cron expression, so a replica that was down over a boundary still sends
 * once when it returns instead of skipping the period entirely. A send that
 * failed does not count as the period's (#352): it stays due and is tried
 * again after a pause (`REPORT_RETRY_PAUSES_MS`).
 */
export async function runDueReports(now = new Date()): Promise<number> {
  return (await runDueReportsDetailed(now)).sent;
}

/**
 * What a run of the due reports did (#369): how many were due, how many were
 * sent, which failed and why, and whether nothing could be tried because email
 * delivery is not set up. "Send due now" said "Nothing was due" for a run in
 * which a due report had just failed, because only the sent count came back.
 */
export interface DueReportsRun {
  due: number;
  sent: number;
  failed: Array<{ name: string; error: string }>;
  /** Email delivery is not set up, so nothing was attempted. */
  emailNotConfigured: boolean;
  /** Reports whose last send failed and that wait for their next automatic try, so were not due now. */
  waiting: string[];
}

export async function runDueReportsDetailed(now = new Date()): Promise<DueReportsRun> {
  const run: DueReportsRun = {
    due: 0,
    sent: 0,
    failed: [],
    emailNotConfigured: false,
    waiting: [],
  };
  if (!(await isSmtpUsable())) {
    logger.debug('Scheduled reports skipped: email delivery is not configured');
    // Whether anything was due is not known to the page without looking; say
    // only that email is not set up.
    run.emailNotConfigured = true;
    return run;
  }

  const reports = await db
    .select()
    .from(schema.scheduledReport)
    .where(eq(schema.scheduledReport.enabled, true));

  for (const report of reports) {
    if (!isDue(report, now)) {
      if (report.lastStatus === 'error') run.waiting.push(report.name);
      continue;
    }
    run.due += 1;

    const result = await sendReport(report);
    if (result.delivered) {
      await db
        .update(schema.scheduledReport)
        .set({
          lastRunAt: now,
          lastStatus: 'success',
          lastError: null,
          lastAttemptAt: null,
          failedAttempts: 0,
        })
        .where(eq(schema.scheduledReport.id, report.id));
      run.sent += 1;
    } else if (result.notConfigured) {
      run.emailNotConfigured = true;
    } else {
      run.failed.push({ name: report.name, error: result.error });
      // `lastRunAt` stays as it was: the period has not been sent (#352).
      await db
        .update(schema.scheduledReport)
        .set({
          lastStatus: 'error',
          lastError: result.error,
          lastAttemptAt: now,
          failedAttempts: sql`${schema.scheduledReport.failedAttempts} + 1`,
        })
        .where(eq(schema.scheduledReport.id, report.id));
    }
  }

  return run;
}

/**
 * Sends one report now, whether or not it is due (#352): the way to send what
 * a failure left unsent without waiting for the next retry, and to send a
 * copy of one that is fine. A report that was failing counts as sent for its
 * period once this delivers it (the failure is cleared and the schedule moves
 * on). A copy of a healthy report changes nothing about its schedule. A
 * failed manual attempt is reported to the caller and, on a failing report,
 * kept as its error without using up an automatic retry.
 *
 * Returns null when there is no such report.
 */
export async function sendReportNow(
  id: string,
  now = new Date(),
): Promise<{ delivered: boolean; error: string | null } | null> {
  const [report] = await db
    .select()
    .from(schema.scheduledReport)
    .where(eq(schema.scheduledReport.id, id))
    .limit(1);
  if (!report) return null;
  if (report.recipients.length === 0) return { delivered: false, error: 'It has no recipients' };
  if (!(await isSmtpUsable())) return { delivered: false, error: 'Email delivery is not set up' };

  const failing = report.lastStatus === 'error';
  const result = await sendReport(report);
  if (result.delivered) {
    if (failing)
      await db
        .update(schema.scheduledReport)
        .set({
          lastRunAt: now,
          lastStatus: 'success',
          lastError: null,
          lastAttemptAt: null,
          failedAttempts: 0,
        })
        .where(eq(schema.scheduledReport.id, id));
    return { delivered: true, error: null };
  }
  if (failing)
    await db
      .update(schema.scheduledReport)
      .set({ lastError: result.error })
      .where(eq(schema.scheduledReport.id, id));
  return { delivered: false, error: result.error };
}
