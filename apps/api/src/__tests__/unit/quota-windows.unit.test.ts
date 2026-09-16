import { describe, expect, it } from 'vitest';
import {
  isValidTimezone,
  resolveWindow,
  type WindowDefinition,
} from '../../services/quota/windows.js';

/** Renders an instant as wall-clock time in a zone, for readable assertions. */
function wallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(instant)
    .replace(', 24:', ', 00:');
}

describe('rolling windows', () => {
  it('falls back to a 24-hour window for an unrecognized persisted kind', () => {
    const now = new Date('2026-03-10T15:00:00Z');
    const definition = {
      windowKind: 'unknown',
      windowHours: 6,
      timezone: 'UTC',
    } as unknown as WindowDefinition;

    expect(resolveWindow(definition, now)).toEqual({
      start: new Date('2026-03-09T15:00:00Z'),
      resetsAt: null,
    });
  });

  it('looks back exactly the configured number of hours', () => {
    const now = new Date('2026-03-10T15:30:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'rolling', windowHours: 6, timezone: 'UTC' },
      now,
    );

    expect(start.toISOString()).toBe('2026-03-10T09:30:00.000Z');
    // A rolling allowance frees up continuously, so there is no fixed reset.
    expect(resetsAt).toBeNull();
  });

  it('defaults to 24 hours when no length is stored', () => {
    const now = new Date('2026-03-10T15:00:00Z');
    const { start } = resolveWindow(
      { windowKind: 'rolling', windowHours: null, timezone: 'UTC' },
      now,
    );

    expect(start.toISOString()).toBe('2026-03-09T15:00:00.000Z');
  });
});

describe('calendar windows', () => {
  it('anchors a daily window to local midnight, not UTC midnight', () => {
    // 03:00 UTC is still the previous evening in New York.
    const now = new Date('2026-06-15T03:00:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'daily', windowHours: null, timezone: 'America/New_York' },
      now,
    );

    expect(wallClock(start, 'America/New_York')).toBe('2026-06-14, 00:00');
    expect(wallClock(resetsAt!, 'America/New_York')).toBe('2026-06-15, 00:00');
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(resetsAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('produces a 23-hour day when DST springs forward', () => {
    // US DST begins 2026-03-08; that local day is only 23 hours long.
    const now = new Date('2026-03-08T18:00:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'daily', windowHours: null, timezone: 'America/New_York' },
      now,
    );

    expect(wallClock(start, 'America/New_York')).toBe('2026-03-08, 00:00');
    expect((resetsAt!.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('produces a 25-hour day when DST falls back', () => {
    const now = new Date('2026-11-01T18:00:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'daily', windowHours: null, timezone: 'America/New_York' },
      now,
    );

    expect(wallClock(start, 'America/New_York')).toBe('2026-11-01, 00:00');
    expect((resetsAt!.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('starts a weekly window on the local Sunday', () => {
    // 2026-06-15 is a Monday.
    const now = new Date('2026-06-15T12:00:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'weekly', windowHours: null, timezone: 'UTC' },
      now,
    );

    expect(start.toISOString()).toBe('2026-06-14T00:00:00.000Z');
    expect(resetsAt!.toISOString()).toBe('2026-06-21T00:00:00.000Z');
  });

  it('starts a monthly window on the first local day and rolls into the next month', () => {
    const now = new Date('2026-12-20T12:00:00Z');
    const { start, resetsAt } = resolveWindow(
      { windowKind: 'monthly', windowHours: null, timezone: 'UTC' },
      now,
    );

    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // December must roll into the following January, not month 13.
    expect(resetsAt!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a zone ahead of UTC', () => {
    const now = new Date('2026-06-15T20:00:00Z');
    const { start } = resolveWindow(
      { windowKind: 'daily', windowHours: null, timezone: 'Asia/Tokyo' },
      now,
    );

    // 20:00 UTC is already the next day in Tokyo.
    expect(wallClock(start, 'Asia/Tokyo')).toBe('2026-06-16, 00:00');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const { start } = resolveWindow(
      { windowKind: 'daily', windowHours: null, timezone: 'Mars/Olympus_Mons' },
      now,
    );

    expect(start.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('timezone validation', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London'])('accepts %s', (zone) => {
    expect(isValidTimezone(zone)).toBe(true);
  });

  it.each(['Mars/Olympus_Mons', 'Not/AZone', ''])('rejects %j', (zone) => {
    expect(isValidTimezone(zone)).toBe(false);
  });
});
