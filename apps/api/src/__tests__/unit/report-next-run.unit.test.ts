import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ db: {} }));

const { nextReportRunAt } = await import('../../services/reports.js');

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
