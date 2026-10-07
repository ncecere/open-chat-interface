import type { ReadOnlyStatus } from '@oci/shared';
import { Lock } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '~/lib/api-client';
import {
  isReadOnlyStatus,
  readOnlyMessage,
  setReadOnlyStatus,
  useReadOnlyStatus,
} from '~/lib/read-only';
import { cn } from '~/lib/utils';

const POLL_MS = 30_000;
/** Asked just after a window's edge, once the server applies it. */
const WINDOW_EDGE_MS = 1_000;
/** setTimeout's longest delay; a window further off is met by the polling. */
const POLL_LIMIT_MS = 2_147_483_647;

/** Asks the API now. Failures leave the state as it was (a refused write still updates it). */
export async function refreshReadOnlyStatus(): Promise<void> {
  try {
    const status = await api.get<ReadOnlyStatus>('/maintenance');
    if (isReadOnlyStatus(status)) setReadOnlyStatus(status);
  } catch {
    // Offline or an older server: nothing to show.
  }
}

/**
 * Keeps the read-only state current (v0.11 design, section 9): asks on mount,
 * every 30 seconds and when the tab regains focus; a refused write updates it
 * in between (lib/read-only.ts). A plain timer rather than a query, so it
 * works wherever a layout mounts it.
 */
export function useReadOnlyPolling(): ReadOnlyStatus {
  useEffect(() => {
    void refreshReadOnlyStatus();
    const timer = setInterval(() => void refreshReadOnlyStatus(), POLL_MS);
    const onFocus = () => void refreshReadOnlyStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  const status = useReadOnlyStatus();
  // A scheduled window starts and ends on time on an open page too, as its
  // announcement leaves (#160), rather than up to a poll later.
  const startsAt = status.window?.startsAt;
  const endsAt = status.window?.endsAt;
  useEffect(() => {
    const timers = [startsAt, endsAt].flatMap((at) => {
      const delay = at ? Date.parse(at) - Date.now() + WINDOW_EDGE_MS : Number.NaN;
      return delay > 0 && delay < POLL_LIMIT_MS
        ? [setTimeout(() => void refreshReadOnlyStatus(), delay)]
        : [];
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [startsAt, endsAt]);
  return status;
}

/**
 * Why changes are paused and until when, above the page while read-only.
 * Not dismissable: it explains why the composer and Save buttons are off.
 * The announcement ahead of a scheduled window is an ordinary broadcast.
 */
export function ReadOnlyBanner({ className }: { className?: string }) {
  const status = useReadOnlyPolling();
  if (!status.active) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 border-b border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-2.5 text-sm',
        className,
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-relaxed text-[var(--text-secondary)]">
        {readOnlyMessage(status)}
      </p>
    </div>
  );
}
