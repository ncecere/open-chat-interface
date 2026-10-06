import { eq, schema } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeSmtp, refusingPort, startFakeSmtp } from '../../../test/fake-smtp.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * A scheduled report whose email failed is tried again (#352). It was counted
 * as sent for its whole period ("Next: in 1d", a month for a monthly one) and
 * nothing sent it when the mail server came back. The real `reports.send-due`
 * job and real nodemailer against the live database; the mail server is a
 * local port that refuses, then a fake SMTP server started on that same port.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', smtpPort: 0 }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Fix8 Mail' }));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getDisplayTimezone: async () => 'UTC',
  getRetentionSettings: async () => ({ usageEventRetentionDays: 30 }),
}));
vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...actual,
    getSetting: async (key: string) =>
      key === 'smtp'
        ? {
            host: '127.0.0.1',
            port: state.smtpPort,
            secure: false,
            fromAddress: 'oci@example.test',
            username: null,
            encryptedPassword: null,
          }
        : key === 'branding'
          ? { appName: 'Fix8 Mail' }
          : actual.getSetting(key as never),
  };
});

const available = await livePostgresAvailable();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!available)('live: scheduled reports whose email failed (#352)', () => {
  let live: LiveDatabase;
  let smtp: FakeSmtp | null = null;
  let reports: typeof import('../../services/reports.js');
  let sendDue: () => Promise<unknown>;
  const t0 = new Date('2026-10-06T08:00:00Z');

  beforeAll(async () => {
    live = await createLiveDatabase('report_retry');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    reports = await import('../../services/reports.js');
    const { lifecycleJobs } = await import('../../services/jobs/index.js');
    const job = lifecycleJobs().find((entry) => entry.name === 'reports.send-due')!;
    sendDue = () => job.run();
  });
  beforeEach(async () => {
    state.smtpPort = await refusingPort();
    await live.db.delete(schema.scheduledReport);
  });
  afterEach(async () => {
    await smtp?.close();
    smtp = null;
  });
  afterAll(async () => {
    await live?.destroy();
  });

  /** The mail server comes back on the port that refused. */
  async function mailServerReturns() {
    smtp = await startFakeSmtp(state.smtpPort);
    return smtp;
  }
  async function addReport(values: Partial<typeof schema.scheduledReport.$inferInsert> = {}) {
    const [row] = await live.db
      .insert(schema.scheduledReport)
      .values({
        organizationId: state.organizationId,
        name: 'Fix8 daily usage',
        cadence: 'daily',
        windowDays: 1,
        recipients: ['finance@example.test'],
        ...values,
      })
      .returning();
    return row!;
  }
  const row = async (id: string) =>
    (
      await live.db.select().from(schema.scheduledReport).where(eq(schema.scheduledReport.id, id))
    )[0]!;

  it('does not count a failed send as the period’s, and sends it once the mail server is back', async () => {
    const report = await addReport();
    // The real job, with the mail server away.
    expect(await sendDue()).toBe(0);
    const failed = await row(report.id);
    expect(failed).toMatchObject({
      lastStatus: 'error',
      lastError: 'Email delivery failed',
      failedAttempts: 1,
    });
    // Before: lastRunAt was the failed attempt, so "Next: in 1d" and nothing more.
    expect(failed.lastRunAt).toBeNull();
    expect(failed.lastAttemptAt).toBeInstanceOf(Date);
    const next = reports.nextReportRunAt(failed, failed.lastAttemptAt!)!;
    expect(next.getTime() - failed.lastAttemptAt!.getTime()).toBe(15 * MINUTE);

    // Not again straight away: the pause counts from the attempt.
    const server = await mailServerReturns();
    expect(
      await reports.runDueReports(new Date(failed.lastAttemptAt!.getTime() + 14 * MINUTE)),
    ).toBe(0);
    expect(server.messages).toHaveLength(0);
    expect((await row(report.id)).failedAttempts).toBe(1);

    // After it, the same job sends it: nothing had to be recreated.
    const later = new Date(failed.lastAttemptAt!.getTime() + 16 * MINUTE);
    expect(await reports.runDueReports(later)).toBe(1);
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]?.data).toContain('Subject: Fix8 Mail: Fix8 daily usage');
    const sent = await row(report.id);
    expect(sent).toMatchObject({
      lastStatus: 'success',
      lastError: null,
      lastAttemptAt: null,
      failedAttempts: 0,
    });
    expect(sent.lastRunAt?.getTime()).toBe(later.getTime());
    // Counted now: not sent again within the period.
    expect(await reports.runDueReports(new Date(later.getTime() + HOUR))).toBe(0);
    expect(server.messages).toHaveLength(1);
  });

  it('keeps a report that was sent before due after a failure, with the earlier send intact', async () => {
    const lastSent = new Date(t0.getTime() - 2 * DAY);
    const report = await addReport({ lastRunAt: lastSent, lastStatus: 'success' });
    expect(await reports.runDueReports(t0)).toBe(0);
    const failed = await row(report.id);
    expect(failed.lastRunAt?.getTime()).toBe(lastSent.getTime());
    expect(failed).toMatchObject({ lastStatus: 'error', failedAttempts: 1 });
  });

  it('retries a bounded number of times, then waits for the next period', async () => {
    const report = await addReport();
    let now = t0;
    // The first attempt and three retries, each after its pause.
    for (const pause of [0, ...reports.REPORT_RETRY_PAUSES_MS]) {
      now = new Date(now.getTime() + pause);
      expect(await reports.runDueReports(now)).toBe(0);
    }
    const exhausted = await row(report.id);
    expect(exhausted.failedAttempts).toBe(4);
    expect(reports.retriesLeft(exhausted)).toBe(0);

    // Used up: not tried every hour however long the failure lasts.
    for (let hour = 1; hour <= 23; hour++)
      await reports.runDueReports(new Date(now.getTime() + hour * HOUR));
    expect((await row(report.id)).failedAttempts).toBe(4);

    // A full period after the last attempt it is tried once more.
    await reports.runDueReports(new Date(now.getTime() + DAY));
    expect((await row(report.id)).failedAttempts).toBe(5);
  });

  it('can always be sent now, whether it is due or not, and a delivery clears the failure', async () => {
    const lastSent = new Date(t0.getTime() - 2 * DAY);
    const report = await addReport({ lastRunAt: lastSent, lastStatus: 'success' });
    await reports.runDueReports(t0);
    expect((await row(report.id)).failedAttempts).toBe(1);

    // Not due for 15 minutes; Send now does not wait.
    const server = await mailServerReturns();
    const at = new Date(t0.getTime() + MINUTE);
    expect(await reports.runDueReports(at)).toBe(0);
    expect(await reports.sendReportNow(report.id, at)).toEqual({ delivered: true, error: null });
    expect(server.messages).toHaveLength(1);
    const sent = await row(report.id);
    expect(sent).toMatchObject({ lastStatus: 'success', lastError: null, failedAttempts: 0 });
    expect(sent.lastRunAt?.getTime()).toBe(at.getTime());
    expect(reports.nextReportRunAt(sent, at)?.getTime()).toBe(at.getTime() + DAY);
  });

  it('says why Send now could not deliver, without using up an automatic retry', async () => {
    const report = await addReport({ lastRunAt: new Date(t0.getTime() - 2 * DAY) });
    await reports.runDueReports(t0);
    expect(await reports.sendReportNow(report.id, t0)).toEqual({
      delivered: false,
      error: 'Email delivery failed',
    });
    const after = await row(report.id);
    expect(after).toMatchObject({ lastStatus: 'error', failedAttempts: 1 });
    expect(await reports.sendReportNow('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('sending a copy of a healthy report leaves its schedule alone', async () => {
    const lastSent = new Date(t0.getTime() - HOUR);
    const report = await addReport({ lastRunAt: lastSent, lastStatus: 'success' });
    const server = await mailServerReturns();
    expect(await reports.sendReportNow(report.id, t0)).toEqual({ delivered: true, error: null });
    expect(server.messages).toHaveLength(1);
    expect((await row(report.id)).lastRunAt?.getTime()).toBe(lastSent.getTime());
  });
});
