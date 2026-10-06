import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ db: {} }));

const { nextReportRunAt, retriesLeft } = await import('../../services/reports.js');

const now = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('when a scheduled report is next sent (#85)', () => {
  it('is never while paused', () => {
    expect(nextReportRunAt({ enabled: false, cadence: 'daily', lastRunAt: null }, now)).toBeNull();
  });

  it('is at the next hourly check when never sent or already due', () => {
    expect(nextReportRunAt({ enabled: true, cadence: 'weekly', lastRunAt: null }, now)).toEqual(
      now,
    );
    const overdue = new Date(now.getTime() - 10 * DAY);
    expect(nextReportRunAt({ enabled: true, cadence: 'weekly', lastRunAt: overdue }, now)).toEqual(
      now,
    );
  });

  it('is a cadence after the last send', () => {
    const last = new Date(now.getTime() - 2 * DAY);
    expect(nextReportRunAt({ enabled: true, cadence: 'weekly', lastRunAt: last }, now)).toEqual(
      new Date(last.getTime() + 7 * DAY),
    );
    expect(nextReportRunAt({ enabled: true, cadence: 'monthly', lastRunAt: last }, now)).toEqual(
      new Date(last.getTime() + 30 * DAY),
    );
  });
});

describe('a report whose email failed (#352)', () => {
  const MINUTE = 60 * 1000;
  const report = { enabled: true, cadence: 'monthly' as const };

  it('is next tried after a short pause, not a period', () => {
    const attempt = new Date(now.getTime() - 5 * MINUTE);
    expect(
      nextReportRunAt(
        { ...report, lastRunAt: null, lastAttemptAt: attempt, failedAttempts: 1 },
        now,
      ),
    ).toEqual(new Date(attempt.getTime() + 15 * MINUTE));
    // Before: a failed attempt was recorded as the send, so 30 days.
    const lastSent = new Date(now.getTime() - 40 * DAY);
    expect(
      nextReportRunAt(
        { ...report, lastRunAt: lastSent, lastAttemptAt: attempt, failedAttempts: 2 },
        now,
      ),
    ).toEqual(new Date(attempt.getTime() + 60 * MINUTE));
  });

  it('waits a period once the automatic tries are used up', () => {
    const attempt = new Date(now.getTime() - 5 * MINUTE);
    const failed = { ...report, lastRunAt: null, lastAttemptAt: attempt, failedAttempts: 4 };
    expect(retriesLeft(failed)).toBe(0);
    expect(nextReportRunAt(failed, now)).toEqual(new Date(attempt.getTime() + 30 * DAY));
    expect(retriesLeft({ failedAttempts: 1 })).toBe(3);
    expect(retriesLeft({})).toBe(4);
  });

  it('never reports a time in the past', () => {
    const attempt = new Date(now.getTime() - 2 * DAY);
    expect(
      nextReportRunAt(
        { ...report, lastRunAt: null, lastAttemptAt: attempt, failedAttempts: 1 },
        now,
      ),
    ).toEqual(now);
  });
});
