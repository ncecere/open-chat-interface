/**
 * Which successful backups to keep: the newest backup of each of the last
 * `keepDaily` days that have one, plus the newest backup of each of the last
 * `keepWeekly` ISO weeks that have one (UTC). Everything else is pruned.
 *
 * Counting days and weeks that have a backup, rather than calendar days,
 * means a pause in backups never deletes the last good ones.
 */

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO 8601 week, such as `2026-W40`, in UTC. */
export function isoWeekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of this week decides the ISO year.
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function newestPerBucket<T extends { id: string; startedAt: Date }>(
  runs: T[],
  bucket: (date: Date) => string,
  limit: number,
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.size >= limit) break;
    const key = bucket(run.startedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(run.id);
  }
  return kept;
}

export function selectBackupsToKeep<T extends { id: string; startedAt: Date }>(
  runs: T[],
  keepDaily: number,
  keepWeekly: number,
): Set<string> {
  const newestFirst = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  return new Set([
    ...newestPerBucket(newestFirst, dayKey, Math.max(1, keepDaily)),
    ...newestPerBucket(newestFirst, isoWeekKey, Math.max(0, keepWeekly)),
  ]);
}
