import type { ActiveBroadcast } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, TriangleAlert, X } from 'lucide-react';
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

/**
 * Instance announcements, shown above the application.
 *
 * A banner rather than a toast: these are things a user should be able to
 * re-read while they work, such as a maintenance window, so they stay until
 * dismissed instead of disappearing on a timer.
 */
export function BroadcastBanner() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['me', 'broadcasts'],
    queryFn: () => api.get<{ broadcasts: ActiveBroadcast[] }>('/me/broadcasts'),
    // Long enough not to poll noisily, short enough that an announcement
    // published now reaches an open tab without a reload.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

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

  const broadcasts = data?.broadcasts ?? [];
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
                {broadcast.body}
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
