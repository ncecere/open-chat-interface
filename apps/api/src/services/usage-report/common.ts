import { getDisplayTimezone } from '../lifecycle/settings.js';
import { type UsageSource, usageSource } from './source.js';

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
export function rangeStart(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * How a report is read. Both sources return the same figures; tests pin the
 * source and the clock to compare them.
 */
export interface ReportOptions {
  /** Default: rollups once their backfill has finished, else the events. */
  source?: UsageSource;
  /** The end of the range (default: now). */
  now?: Date;
}

export async function reportSource(options: ReportOptions): Promise<UsageSource> {
  return options.source ?? (await usageSource());
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
