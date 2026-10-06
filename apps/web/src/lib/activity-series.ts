/**
 * The Overview's "Messages per day" as a series with one point per calendar
 * day (#348). The API sends a point for every day of the window; a server
 * that lists only the days with messages (before v0.11.1) is filled here, so
 * the chart never spreads busy days evenly across quiet ones and its label
 * counts days, not points.
 */

export interface ActivityPoint {
  day: string;
  messages: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every day from the first point's to the last's, oldest first, the missing ones at zero. */
export function denseActivity(points: readonly ActivityPoint[]): ActivityPoint[] {
  const valid = points.filter((point) => DAY.test(point.day));
  const first = valid[0];
  const last = valid.at(-1);
  if (!first || !last) return [...points];
  const counts = new Map(valid.map((point) => [point.day, point.messages]));
  const start = Date.parse(`${first.day}T00:00:00Z`);
  const end = Date.parse(`${last.day}T00:00:00Z`);
  const series: ActivityPoint[] = [];
  for (let at = start; at <= end; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    series.push({ day, messages: counts.get(day) ?? 0 });
  }
  return series;
}

/**
 * A day as a reader writes it ("Oct 1"), with the year when it is not this
 * one. The days are UTC days, so the date is read in UTC: in a zone behind
 * UTC, "2026-10-01" as a local date would be September 30.
 */
export function formatActivityDay(day: string, now = new Date()): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}
