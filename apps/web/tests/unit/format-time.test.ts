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
    // formatRelativeTime measures backwards, so a session valid for another
    // month reads as "just now" — which is what this exists to avoid.
    const nextMonth = new Date(Date.now() + 30 * 86_400_000);
    expect(formatRelativeTime(nextMonth)).toBe('just now');
    expect(formatTimeUntil(nextMonth)).toBe('in 30d');
  });
});
