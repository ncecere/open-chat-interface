import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

interface UsageSummary {
  enabled: boolean;
  windowHours: number;
  resetsAt: string | null;
  messages: { used: number; limit: number | null };
  tokens: { used: number; limit: number | null };
}

function formatCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return null;

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  // The bar depletes as the allowance is consumed, so a full bar means a full
  // allowance remaining.
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const percentRemaining = limit ? Math.max(0, 100 - (used / limit) * 100) : 100;
  const low = remaining !== null && percentRemaining <= 10;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-[var(--text-secondary)]">{label}</span>
        <span
          className={cn(
            'text-xs',
            low ? 'text-[var(--danger-foreground)]' : 'text-[var(--text-muted)]',
          )}
        >
          {remaining === null
            ? `${used.toLocaleString()} used`
            : `${remaining.toLocaleString()} left`}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--bg-segment-track)]">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            low ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]',
          )}
          style={{ width: `${percentRemaining}%` }}
        />
      </div>
      {remaining !== null && (
        <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
          {used.toLocaleString()} of {limit?.toLocaleString()} used
        </p>
      )}
    </div>
  );
}

/**
 * Usage meter for the settings rail. Quotas are optional, so this also
 * reports plain consumption when no limit is configured.
 */
export function UsageLimits() {
  const { data } = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.get<UsageSummary>('/me/usage'),
    staleTime: 30_000,
  });

  if (!data) return null;

  const hasLimits = Boolean(data.enabled && (data.messages.limit || data.tokens.limit));
  const countdown = formatCountdown(data.resetsAt);

  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <p className="text-sm font-semibold">Usage Limits</p>
        <Info
          className="size-3.5 text-[var(--text-muted)]"
          aria-label={`Usage over the last ${data.windowHours} hours`}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Meter label="Messages" used={data.messages.used} limit={data.messages.limit} />
        <Meter label="Tokens" used={data.tokens.used} limit={data.tokens.limit} />
      </div>

      <p className="mt-3 text-xs text-[var(--text-muted)]">
        {hasLimits && countdown
          ? `Frees up in ${countdown}`
          : hasLimits
            ? `Rolling ${data.windowHours}h window`
            : `No limits applied · last ${data.windowHours}h`}
      </p>
    </div>
  );
}
