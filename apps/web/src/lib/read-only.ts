import { INACTIVE_READ_ONLY_STATUS, type ReadOnlyStatus } from '@oci/shared';
import { useSyncExternalStore } from 'react';

/**
 * Read-only maintenance mode in the browser (v0.11 design, section 9).
 *
 * One small store, outside React Query so the composer and the message
 * actions can read it without a query client: the banner keeps it current by
 * polling `/api/maintenance`, and any write the API refuses with `423
 * READ_ONLY` (a write that raced the switch) updates it at once from the
 * refusal itself, so the page explains why instead of showing an error.
 */

let current: ReadOnlyStatus = INACTIVE_READ_ONLY_STATUS;
const listeners = new Set<() => void>();

export function readOnlyStatus(): ReadOnlyStatus {
  return current;
}

export function setReadOnlyStatus(next: ReadOnlyStatus): void {
  if (
    next.active === current.active &&
    next.source === current.source &&
    next.reason === current.reason &&
    next.until === current.until &&
    next.window?.startsAt === current.window?.startsAt &&
    next.window?.endsAt === current.window?.endsAt
  )
    return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current status; re-renders when it changes. */
export function useReadOnlyStatus(): ReadOnlyStatus {
  return useSyncExternalStore(subscribe, readOnlyStatus, readOnlyStatus);
}

/** Whether a value has the shape of `GET /api/maintenance`'s answer. */
export function isReadOnlyStatus(value: unknown): value is ReadOnlyStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReadOnlyStatus).active === 'boolean'
  );
}

/**
 * Notes a refusal's body (`{ error: { code: 'READ_ONLY', details: { readOnly } } }`).
 * Returns whether it was one.
 */
export function noteReadOnlyRefusal(body: unknown): boolean {
  const error = (body as { error?: { code?: unknown; details?: { readOnly?: unknown } } } | null)
    ?.error;
  if (error?.code !== 'READ_ONLY') return false;
  const status = error.details?.readOnly;
  setReadOnlyStatus(
    isReadOnlyStatus(status)
      ? status
      : { ...INACTIVE_READ_ONLY_STATUS, active: true, source: 'administrator' },
  );
  return true;
}

/**
 * The read-only status a Better Auth client error carries, when it is a
 * read-only refusal: the client spreads the API's body into the error
 * (`{ error: { code: 'READ_ONLY', … }, status: 423 }`). Notes it as well, so
 * the banner and the other controls follow. Null for any other error.
 */
export function authReadOnlyRefusal(error: unknown): ReadOnlyStatus | null {
  if ((error as { status?: unknown } | null)?.status !== 423) return null;
  return noteReadOnlyRefusal(error) ? current : null;
}

/** Reads a `423` response's body without consuming the caller's copy. */
export async function noteReadOnlyResponse(response: Response): Promise<void> {
  if (response.status !== 423) return;
  try {
    noteReadOnlyRefusal(await response.clone().json());
  } catch {
    // Not a JSON body: not ours.
  }
}

/**
 * "14:30" today, "Mon 5 Oct, 14:30" on another day this year, and with the
 * year in another year ("Sun 10 Jan 2027, 14:30", #81), in the person's own zone.
 */
export function formatReadOnlyTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One sentence for people: why changes are paused, and until when if known. */
export function readOnlyMessage(status: ReadOnlyStatus, now = new Date()): string {
  const until = status.until ? ` until about ${formatReadOnlyTime(status.until, now)}` : '';
  const reason = status.reason ? ` ${status.reason.trim().replace(/([^.!?])$/, '$1.')}` : '';
  return `Read-only for maintenance${until}: you can read, search and export, but changes can’t be saved.${reason}`;
}

/**
 * Forgot password while read-only: a reset is a change, so it is refused and
 * no email goes out; say so rather than "a link has been sent" (#138).
 */
export function passwordResetPausedMessage(status: ReadOnlyStatus, now = new Date()): string {
  const until = status.until ? ` until about ${formatReadOnlyTime(status.until, now)}` : '';
  const reason = status.reason ? ` ${status.reason.trim().replace(/([^.!?])$/, '$1.')}` : '';
  return `Password resets are paused for maintenance${until}, and no reset email has been sent.${reason} Try again once maintenance is over.`;
}

/** Short reason for a disabled control's tooltip. */
export function readOnlyShortReason(status: ReadOnlyStatus, now = new Date()): string {
  return status.until
    ? `Read-only for maintenance until about ${formatReadOnlyTime(status.until, now)}`
    : 'Read-only for maintenance';
}
