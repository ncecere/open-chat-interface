import { getDisplayTimezone } from '../lifecycle/settings.js';

/**
 * How far back per-event history reaches. Beyond this, events have been pruned
 * and only the UTC-bucketed daily rollup survives, so a longer range would
 * silently change what a "day" means.
 */
export const EVENT_HISTORY_DAYS = 90;

export interface UsageReportRange {
  days: number;
  timezone: string;
  /** True when the range is answered from local-time event data. */
  exact: boolean;
}

/** Raw SQL binds text, so the boundary is passed as an ISO string. */
export function rangeStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A bounded list plus what it left out, so a truncated view says so. */
export interface Bounded<T> {
  entries: T[];
  totalCount: number;
}

export async function usageRange(days: number): Promise<UsageReportRange> {
  return {
    days,
    timezone: await getDisplayTimezone(),
    // Beyond the event retention window the underlying rows are gone, so the
    // page must not imply the numbers are complete.
    exact: days <= EVENT_HISTORY_DAYS,
  };
}
