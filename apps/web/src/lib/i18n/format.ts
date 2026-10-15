/**
 * The one place dates, times, numbers, relative times, lists and file sizes
 * are written for a person. Everything else in the web app calls these instead
 * of `toLocale*` or `Intl` directly, so a language change reaches all of it
 * and a stray `toLocaleString` is a lint failure (`scripts/check-i18n.mjs`).
 *
 * Each function takes the locale to use in `options.locale` (an `Intl` tag
 * such as `ar`, not an app locale such as `ar-XB`) and otherwise uses the
 * locale the app is showing.
 */

export type DateStyle = 'short' | 'medium' | 'long' | 'time' | 'dateTime';
export type NumberStyle = 'decimal' | 'integer' | 'percent' | 'compact';

export interface FormatOptions {
  /** An `Intl` locale tag; the current locale when omitted. */
  locale?: string;
  /** An IANA zone such as `UTC`; the browser's zone when omitted. */
  timeZone?: string;
}

let currentIntlLocale = 'en';

/** Called by the i18n state when the language changes; not for components. */
export function setFormatLocale(intlLocale: string): void {
  currentIntlLocale = intlLocale;
}

export function getFormatLocale(): string {
  return currentIntlLocale;
}

// Constructing an Intl formatter is the slow part; a list of 200 rows would
// build 200 of them. Keyed by everything that distinguishes one.
const cache = new Map<string, unknown>();

function cached<T>(kind: string, locale: string, options: object, make: () => T): T {
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  let found = cache.get(key) as T | undefined;
  if (!found) {
    found = make();
    cache.set(key, found);
  }
  return found;
}

function localeOf(options?: FormatOptions): string {
  return options?.locale ?? currentIntlLocale;
}

export function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatNumber(
  value: number,
  options: FormatOptions & {
    style?: NumberStyle;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {},
): string {
  const { style = 'decimal', minimumFractionDigits, maximumFractionDigits } = options;
  const intl: Intl.NumberFormatOptions = {
    ...(style === 'percent' && { style: 'percent' }),
    ...(style === 'integer' && { maximumFractionDigits: 0 }),
    ...(style === 'compact' && { notation: 'compact' }),
    ...(minimumFractionDigits !== undefined && { minimumFractionDigits }),
    ...(maximumFractionDigits !== undefined && { maximumFractionDigits }),
  };
  const locale = localeOf(options);
  return cached('number', locale, intl, () => new Intl.NumberFormat(locale, intl)).format(value);
}

const DATE_FORMATS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  time: { timeStyle: 'short' },
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
};

/** A date, a time, or both. An unreadable value comes back as written, never as "Invalid Date". */
export function formatDate(
  value: Date | string | number,
  style: DateStyle = 'medium',
  options: FormatOptions = {},
): string {
  const date = toDate(value);
  if (!date) return String(value);
  const intl: Intl.DateTimeFormatOptions = {
    ...DATE_FORMATS[style],
    ...(options.timeZone && { timeZone: options.timeZone }),
  };
  const locale = localeOf(options);
  return cached('date', locale, intl, () => new Intl.DateTimeFormat(locale, intl)).format(date);
}

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * "3 hours ago", "yesterday", "in 2 days". Past a month it is the date, since
 * "11 weeks ago" says less than the day. `now` is for tests.
 */
export function formatRelativeTime(
  value: Date | string | number,
  options: FormatOptions & { now?: Date | number } = {},
): string {
  const date = toDate(value);
  if (!date) return String(value);
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  const seconds = Math.round((date.getTime() - now) / 1_000);
  const magnitude = Math.abs(seconds);
  const locale = localeOf(options);
  const relative = cached(
    'relative',
    locale,
    {},
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
  );
  if (magnitude < 45) return relative.format(0, 'second');
  if (magnitude < HOUR) return relative.format(Math.round(seconds / MINUTE), 'minute');
  if (magnitude < DAY) return relative.format(Math.round(seconds / HOUR), 'hour');
  if (magnitude < 30 * DAY) return relative.format(Math.round(seconds / DAY), 'day');
  return formatDate(date, 'medium', options);
}

/** "A, B, and C" in the locale's own way of joining. */
export function formatList(
  items: readonly string[],
  options: FormatOptions & { type?: 'conjunction' | 'disjunction' } = {},
): string {
  const type = options.type ?? 'conjunction';
  const locale = localeOf(options);
  return cached(
    'list',
    locale,
    { type },
    () => new Intl.ListFormat(locale, { style: 'long', type }),
  ).format(items);
}

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * "512 byte", "1.5 MB": 1,024 to the step, as the storage settings count,
 * with one decimal below ten and none above, in the locale's digits and unit
 * names.
 */
export function formatFileSize(bytes: number, options: FormatOptions = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  let unit = 0;
  let value = bytes;
  while (value >= 1_024 && unit < SIZE_UNITS.length - 1) {
    value /= 1_024;
    unit++;
  }
  const locale = localeOf(options);
  const intl: Intl.NumberFormatOptions = {
    style: 'unit',
    unit: SIZE_UNITS[unit] as string,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
  };
  return cached('size', locale, intl, () => new Intl.NumberFormat(locale, intl)).format(value);
}
