import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * How long until a moment in the future.
 *
 * Unlike `formatRelativeTime`, a moment that has passed reads "expired" rather
 * than "5m ago", which is what an expiry needs.
 */
export function formatTimeUntil(value: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diffMs = date.getTime() - Date.now();

  if (diffMs <= 0) return 'expired';

  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;

  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

/**
 * "5m ago" for a past moment and "in 3d" for a future one. Future times need
 * their own wording (#126): measuring them backwards gave a negative distance,
 * so a report due in 30 days or a webhook retry due in an hour read "just now".
 * Within half a minute either way is "just now", so a timestamp a few seconds
 * ahead through clock skew does not read as though it were still to come.
 */
export function formatRelativeTime(value: string | Date | null, now: number = Date.now()): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diffMs = now - date.getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes === 0) return 'just now';
  if (minutes < 0) return formatAhead(date, -minutes);

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The future half of formatRelativeTime: "in 20m", "in 3h", "in 30d". */
function formatAhead(date: Date, minutes: number): string {
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  // A monthly schedule is 30 days out, so keep counting days a little past a month.
  if (days <= 31) return `in ${days}d`;
  return `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * A moment as admin pages show it, "Oct 5, 2026, 6:27 PM" in the reader's
 * locale. One format everywhere: connectors, webhooks and legal holds used
 * the browser default ("10/5/2026, 6:51:07 PM") beside this one (#177).
 */
export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat.format(date);
}

/** A day as admin pages show it, "Oct 5, 2026" (#177). */
export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? String(value) : dateFormat.format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * A limit as administrators set it and the docs give it: "20 MB", not
 * "20.0 MB"; "1.5 MB" keeps its fraction (#209).
 */
export function formatLimit(bytes: number): string {
  return formatBytes(bytes).replace(/\.0 /, ' ');
}
