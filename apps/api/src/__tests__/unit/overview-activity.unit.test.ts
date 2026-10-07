import { describe, expect, it } from 'vitest';
import { activityWindowStart, fillActivityDays } from '../../services/overview-activity.js';

describe('the Overview messages-per-day series (#348)', () => {
  const now = new Date('2026-10-06T00:30:00Z');

  it('starts the window at UTC midnight, today being its last day', () => {
    expect(activityWindowStart(now).toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(activityWindowStart(now, 3).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('has a point for every day, the quiet ones at zero, oldest first', () => {
    const series = fillActivityDays(
      [
        { day: '2026-10-01', messages: 7 },
        { day: '2026-10-05', messages: 79 },
        { day: '2026-10-06', messages: 3 },
      ],
      now,
    );
    expect(series).toHaveLength(14);
    expect(series[0]).toEqual({ day: '2026-09-23', messages: 0 });
    expect(series.at(-1)).toEqual({ day: '2026-10-06', messages: 3 });
    expect(series.filter((point) => point.messages > 0).map((point) => point.day)).toEqual([
      '2026-10-01',
      '2026-10-05',
      '2026-10-06',
    ]);
  });

  it('crosses a month and a year end without skipping or repeating a day', () => {
    const days = fillActivityDays([], new Date('2027-01-02T23:59:59Z')).map((point) => point.day);
    expect(days.slice(0, 3)).toEqual(['2026-12-20', '2026-12-21', '2026-12-22']);
    expect(days.at(-1)).toBe('2027-01-02');
    expect(new Set(days).size).toBe(14);
  });

  it('ignores a day outside the window rather than adding a point for it', () => {
    const series = fillActivityDays([{ day: '2026-01-01', messages: 9 }], now);
    expect(series.every((point) => point.messages === 0)).toBe(true);
  });
});
