import type { QuotaWindowKind } from '@oci/shared';

export interface WindowBounds {
  /** Inclusive lower bound for counting usage. */
  start: Date;
  /** When the window rolls over, or null when it cannot be known in advance. */
  resetsAt: Date | null;
}

export interface WindowDefinition {
  windowKind: QuotaWindowKind;
  windowHours: number | null;
  timezone: string;
}

/** Falls back to UTC rather than throwing, so a bad zone cannot disable enforcement. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const ZONE_PARTS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

/** Reads the wall-clock fields an instant maps to inside a timezone. */
function zonedParts(instant: Date, timezone: string): Record<(typeof ZONE_PARTS)[number], number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  return {
    year: parts.year ?? 0,
    // Intl reports hour 24 for midnight under hour12: false in some engines.
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Offset in milliseconds between a timezone's wall clock and UTC at an instant. */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Discard sub-second precision so the comparison stays stable.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Resolves a wall-clock time in a timezone to an instant. DST can leave a local
 * time nonexistent or ambiguous, so the offset is re-derived from the first
 * estimate before being applied.
 */
function zonedTimeToInstant(timezone: string, year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timezone));
  return new Date(naive - zoneOffsetMs(firstGuess, timezone));
}

function startOfZonedDay(instant: Date, timezone: string): Date {
  const parts = zonedParts(instant, timezone);
  return zonedTimeToInstant(timezone, parts.year, parts.month, parts.day);
}

function addZonedDays(instant: Date, timezone: string, days: number): Date {
  const parts = zonedParts(instant, timezone);
  return zonedTimeToInstant(timezone, parts.year, parts.month, parts.day + days);
}

/** Local day of week, 0 = Sunday, derived without relying on the host timezone. */
function zonedWeekday(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * Computes the counting window for a policy. Calendar windows are anchored to
 * midnight in the policy timezone, so day length varies correctly across DST.
 */
export function resolveWindow(definition: WindowDefinition, now: Date = new Date()): WindowBounds {
  const timezone = isValidTimezone(definition.timezone) ? definition.timezone : 'UTC';

  switch (definition.windowKind) {
    case 'rolling': {
      const hours = definition.windowHours ?? 24;
      return {
        start: new Date(now.getTime() - hours * 60 * 60 * 1000),
        // A rolling window has no fixed reset; allowance frees up continuously.
        resetsAt: null,
      };
    }
    case 'daily': {
      const start = startOfZonedDay(now, timezone);
      return { start, resetsAt: addZonedDays(start, timezone, 1) };
    }
    case 'weekly': {
      const start = addZonedDays(
        startOfZonedDay(now, timezone),
        timezone,
        -zonedWeekday(now, timezone),
      );
      return { start, resetsAt: addZonedDays(start, timezone, 7) };
    }
    case 'monthly': {
      const parts = zonedParts(now, timezone);
      const start = zonedTimeToInstant(timezone, parts.year, parts.month, 1);
      const resetsAt = zonedTimeToInstant(timezone, parts.year, parts.month + 1, 1);
      return { start, resetsAt };
    }
    default:
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), resetsAt: null };
  }
}
