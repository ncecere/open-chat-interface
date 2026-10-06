import { describe, expect, it } from 'vitest';
import { formatRelativeTime, formatTimeUntil } from '~/lib/utils';

describe('formatTimeUntil', () => {
  it('describes a future moment as a distance ahead', () => {
    expect(formatTimeUntil(new Date(Date.now() + 30 * 86_400_000))).toBe('in 30d');
    expect(formatTimeUntil(new Date(Date.now() + 3 * 3_600_000))).toBe('in 3h');
    expect(formatTimeUntil(new Date(Date.now() + 20 * 60_000))).toBe('in 20m');
  });

  it('calls a past moment expired rather than measuring backwards', () => {
    expect(formatTimeUntil(new Date(Date.now() - 60_000))).toBe('expired');
  });

  it('handles a missing value', () => {
    expect(formatTimeUntil(null)).toBe('—');
  });

  it('does not report a future expiry as though it had just passed', () => {
    const nextMonth = new Date(Date.now() + 30 * 86_400_000);
    expect(formatTimeUntil(nextMonth)).toBe('in 30d');
  });
});

describe('formatRelativeTime (#126)', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');

  it('measures a past moment backwards', () => {
    expect(formatRelativeTime('2026-10-05T11:59:50Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-05T11:40:00Z', now)).toBe('20m ago');
    expect(formatRelativeTime('2026-10-05T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-09-28T12:00:00Z', now)).toBe('7d ago');
  });

  it('gives a future moment its own wording instead of "just now"', () => {
    // A report sent at noon today: monthly is due in 30 days, weekly in 7.
    expect(formatRelativeTime('2026-11-04T12:00:00Z', now)).toBe('in 30d');
    expect(formatRelativeTime('2026-10-12T12:00:00Z', now)).toBe('in 7d');
    expect(formatRelativeTime('2026-10-05T15:00:00Z', now)).toBe('in 3h');
    expect(formatRelativeTime('2026-10-05T12:04:00Z', now)).toBe('in 4m');
    expect(formatRelativeTime('2027-01-05T12:00:00Z', now)).toMatch(/^on Jan 5, 2027$/);
  });

  it('reads a timestamp a few seconds ahead (clock skew) as just now', () => {
    expect(formatRelativeTime('2026-10-05T12:00:10Z', now)).toBe('just now');
  });

  it('uses the real clock by default', () => {
    expect(formatRelativeTime(new Date(Date.now() + 2 * 3_600_000))).toBe('in 2h');
    expect(formatRelativeTime(new Date(Date.now() - 2 * 3_600_000))).toBe('2h ago');
  });
});
