/**
 * The Overview's "Messages per day" series: one point for every one of the
 * last `days` days (UTC), the quiet ones at zero (#348). The query groups
 * only the days that have messages, so the chart used to spread the busy days
 * evenly and draw one line across the quiet ones, and its label counted
 * points rather than days.
 */
export const ACTIVITY_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight that starts the window: today and the days before it, `days` in all. */
export function activityWindowStart(now: Date, days = ACTIVITY_DAYS): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

/** Every day of the window, oldest first, with the counts the query found (zero for the rest). */
export function fillActivityDays(
  rows: ReadonlyArray<{ day: string; messages: number }>,
  now: Date,
  days = ACTIVITY_DAYS,
): { day: string; messages: number }[] {
  const counts = new Map(rows.map((row) => [row.day, row.messages]));
  const start = activityWindowStart(now, days).getTime();
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    return { day, messages: counts.get(day) ?? 0 };
  });
}
