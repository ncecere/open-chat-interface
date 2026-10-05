import { eq, schema } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { isSmtpUsable, sendEmail } from './email.js';
import { getSetting } from './settings.js';
import { dailyUsage, modelUsage, topConsumers, usageTotals } from './usage-report.js';

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

async function buildUsageReport(windowDays: number, appName: string): Promise<string> {
  const [totals, daily, models, consumers] = await Promise.all([
    usageTotals(windowDays),
    dailyUsage(windowDays),
    modelUsage(windowDays, 10),
    topConsumers(windowDays, 10),
  ]);

  const lines: string[] = [
    `${appName} usage, last ${windowDays} days`,
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
    lines.push(
      `  ${model.displayName ?? model.modelSlug}  ${messageCount(model.messages)}  ${formatCost(model.costMicros)}`,
    );
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
 * When a report is next sent (#85): null while paused; otherwise a cadence
 * after its last send, or `now` when it has never been sent or is already
 * due, which the hourly check picks up within the hour.
 */
export function nextReportRunAt(
  report: { enabled: boolean; cadence: keyof typeof CADENCE_MS; lastRunAt: Date | null },
  now = new Date(),
): Date | null {
  if (!report.enabled) return null;
  if (!report.lastRunAt) return now;
  const next = report.lastRunAt.getTime() + CADENCE_MS[report.cadence];
  return new Date(Math.max(next, now.getTime()));
}

/**
 * Sends every scheduled report that is due.
 *
 * Due-ness is decided from `lastRunAt` rather than a cron expression, so a
 * replica that was down over a boundary still sends once when it returns
 * instead of skipping the period entirely.
 */
export async function runDueReports(now = new Date()): Promise<number> {
  if (!(await isSmtpUsable())) {
    logger.debug('Scheduled reports skipped: email delivery is not configured');
    return 0;
  }

  const due = await db
    .select()
    .from(schema.scheduledReport)
    .where(eq(schema.scheduledReport.enabled, true));

  const branding = await getSetting('branding');
  let sent = 0;

  for (const report of due) {
    const interval = CADENCE_MS[report.cadence];
    const elapsed = report.lastRunAt
      ? now.getTime() - report.lastRunAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (elapsed < interval) continue;
    if (report.recipients.length === 0) continue;

    try {
      const body = await buildUsageReport(report.windowDays, branding.appName);

      // sendEmail reports failure by returning a flag rather than throwing, so
      // a bare call here would record every send as a success.
      const { delivered } = await sendEmail({
        to: report.recipients.join(', '),
        subject: `${branding.appName}: ${report.name}`,
        text: body,
      });

      if (!delivered) throw new Error('Email delivery failed');

      await db
        .update(schema.scheduledReport)
        .set({ lastRunAt: now, lastStatus: 'success', lastError: null })
        .where(eq(schema.scheduledReport.id, report.id));
      sent += 1;
    } catch (error) {
      // Recorded on the row rather than only logged, so an administrator can
      // see a report has been failing without reading server logs.
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, reportId: report.id }, 'Scheduled report failed');

      await db
        .update(schema.scheduledReport)
        .set({ lastRunAt: now, lastStatus: 'error', lastError: message.slice(0, 500) })
        .where(eq(schema.scheduledReport.id, report.id));
    }
  }

  return sent;
}
