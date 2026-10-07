import { MICROS_PER_DOLLAR } from '@oci/shared';

export interface Range {
  days: number;
  timezone: string;
  exact: boolean;
}

interface Totals {
  messages: number;
  tokens: number;
  costMicros: number;
  activeUsers: number;
}

export interface OverviewResponse {
  range: Range;
  totals: Totals;
  activity: {
    threadsCreated: number;
    messagesSent: number;
    attachmentsUploaded: number;
    sharesCreated: number;
    searchesRun: number;
    branchesCreated: number;
    temporaryThreads: number;
    erroredResponses: number;
    cancelledResponses: number;
  };
  daily: Array<{ day: string; messages: number; activeUsers: number }>;
}

/** A capped list plus the true total, so a truncated view can say so. */
interface Bounded<T> {
  entries: T[];
  totalCount: number;
}

export interface SpendResponse {
  range: Range;
  totals: Totals;
  daily: Array<{ day: string; messages: number; tokens: number; costMicros: number }>;
  models: Bounded<{
    modelSlug: string;
    displayName: string | null;
    labId: string | null;
    /** Null when not in the chat catalog (an embedding model, or one since removed). */
    enabled: boolean | null;
    messages: number;
    tokens: number;
    costMicros: number;
    errors: number;
  }>;
  /** `deleted` is the one row for every deleted account's usage (no identity). */
  consumers: Bounded<{
    deleted: boolean;
    userId: string | null;
    name: string;
    email: string | null;
    messages: number;
    costMicros: number;
  }>;
  idleModels: Bounded<{ slug: string; displayName: string; labId: string | null }>;
}

export interface LimitsResponse {
  range: Range;
  denials: Bounded<{
    policyId: string | null;
    policyName: string;
    denials: number;
    usersAffected: number;
  }>;
}

export interface StorageResponse {
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
  topUsers: Array<{ userId: string; name: string; email: string; bytes: number; files: number }>;
  totalUsers: number;
}

/**
 * One precision for every spend figure on the page, card and tables alike
 * (#88): cents, with thousands separators, and "<$0.01" for a cost too small
 * to show in cents rather than a run of zeros.
 */
export function money(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  if (micros > 0 && dollars < 0.005) return '<$0.01';
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function bytes(value: number): string {
  const MB = 1024 * 1024;
  if (value >= 1024 * MB) return `${(value / (1024 * MB)).toFixed(2)} GB`;
  if (value >= MB) return `${(value / MB).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/** YYYY-MM-DD for `date` in `timeZone`. */
export function dayIn(timeZone: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Every day of the range, oldest first, with days that recorded nothing as 0.
 * The API returns only days with data, which drew one active day as a block
 * filling the whole 30-day chart, both axis labels the same date.
 */
export function fillDays(
  points: Array<{ day: string; value: number }>,
  days: number,
  endDay: string,
): Array<{ day: string; value: number }> {
  const values = new Map(points.map((point) => [point.day, point.value]));
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (Number.isNaN(end) || days < 1) return points;
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, value: values.get(day) ?? 0 };
  });
}
