import type { ActiveBroadcast } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InlineMarkdown } from '~/components/ui/inline-markdown';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

const LEVEL_STYLES: Record<ActiveBroadcast['level'], string> = {
  info: 'border-[var(--border-subtle)] bg-[var(--bg-control)]/60',
  warning: 'border-[var(--warning)]/40 bg-[var(--warning)]/10',
  critical: 'border-[var(--danger)]/40 bg-[var(--danger)]/10',
};

const LEVEL_ICONS: Record<ActiveBroadcast['level'], typeof Info> = {
  info: Info,
  warning: TriangleAlert,
  critical: AlertTriangle,
};

/** setTimeout's longest delay; a later end is checked again after it. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The announcements still within their end, re-rendering when the next one
 * ends. The list is refreshed only every few minutes, so without this an
 * open page kept a scheduled window's announcement beside the read-only
 * banner after the window started (#160).
 */
function useUnexpired(broadcasts: ActiveBroadcast[]): ActiveBroadcast[] {
  const [now, setNow] = useState(() => Date.now());
  const ends = broadcasts
    .map((broadcast) => (broadcast.endsAt ? Date.parse(broadcast.endsAt) : Number.NaN))
    .filter((end) => Number.isFinite(end) && end > now);
  const next = ends.length ? Math.min(...ends) : null;
  useEffect(() => {
    if (next === null) return;
    const delay = next - Date.now();
    const timer = setTimeout(
      // A timer can fire a moment before the wall clock reaches the time it was set for.
      // Then neither `now` nor `next` would change and no other timer would be set, so the
      // announcement would stay until the next refresh: once this one is due, it is at
      // least `next` now (a later end, clamped to MAX_TIMER_MS, is only checked again).
      () => setNow(delay > MAX_TIMER_MS ? Date.now() : Math.max(Date.now(), next)),
      Math.min(delay, MAX_TIMER_MS),
    );
    return () => clearTimeout(timer);
  }, [next]);
  return broadcasts.filter(
    (broadcast) => !broadcast.endsAt || !(Date.parse(broadcast.endsAt) <= now),
  );
}

function useBroadcasts() {
  return useQuery({
    queryKey: ['me', 'broadcasts'],
    queryFn: () => api.get<{ broadcasts: ActiveBroadcast[] }>('/me/broadcasts'),
    // Long enough not to poll noisily, short enough that an announcement
    // published now reaches an open tab without a reload.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

/** However slow the request, the page is shown after this long. */
const MAX_WAIT_MS = 3_000;

/**
 * Whether the first answer about announcements is in (or failed, or took
 * too long). The chat shell lays its page out hidden until then: a banner
 * arriving after the page had painted pushed it down by its own height, a
 * layout shift of 0.08-0.13 (#167). Refetches never hide it again.
 */
export function useBroadcastsSettled(): boolean {
  const { isPending } = useBroadcasts();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!isPending) return;
    const timer = setTimeout(() => setTimedOut(true), MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [isPending]);
  return !isPending || timedOut;
}

/**
 * Instance announcements, shown above the application.
 *
 * A banner rather than a toast: these are things a user should be able to
 * re-read while they work, such as a maintenance window, so they stay until
 * dismissed instead of disappearing on a timer.
 */
export function BroadcastBanner() {
  const queryClient = useQueryClient();

  const { data } = useBroadcasts();

  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/me/broadcasts/${id}/dismiss`),
    onMutate: async (id) => {
      // Hide it at once; waiting on the round trip makes the click feel broken.
      await queryClient.cancelQueries({ queryKey: ['me', 'broadcasts'] });
      const previous = queryClient.getQueryData<{ broadcasts: ActiveBroadcast[] }>([
        'me',
        'broadcasts',
      ]);
      queryClient.setQueryData<{ broadcasts: ActiveBroadcast[] }>(
        ['me', 'broadcasts'],
        (current) =>
          current ? { broadcasts: current.broadcasts.filter((entry) => entry.id !== id) } : current,
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['me', 'broadcasts'], context.previous);
      }
    },
  });

  const broadcasts = useUnexpired(data?.broadcasts ?? []);
  if (broadcasts.length === 0) return null;

  return (
    <div className="flex flex-col">
      {broadcasts.map((broadcast) => {
        const Icon = LEVEL_ICONS[broadcast.level];

        return (
          <div
            key={broadcast.id}
            role={broadcast.level === 'critical' ? 'alert' : 'status'}
            className={cn(
              'flex items-start gap-3 border-b px-4 py-2.5 text-sm',
              LEVEL_STYLES[broadcast.level],
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--text-primary)]">{broadcast.title}</p>
              <p className="mt-0.5 leading-relaxed text-[var(--text-secondary)]">
                <InlineMarkdown text={broadcast.body} />
              </p>
            </div>
            {broadcast.dismissable && (
              <button
                type="button"
                aria-label={`Dismiss: ${broadcast.title}`}
                onClick={() => dismiss.mutate(broadcast.id)}
                className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
