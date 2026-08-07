import { MICROS_PER_DOLLAR, type UsageAllowance, type UsageSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

function formatCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return null;

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Cost is stored in micro-dollars; everything else is a plain count. */
function formatAmount(value: number, metric: UsageAllowance['metric']): string {
  if (metric !== 'cost') return value.toLocaleString();

  const dollars = value / MICROS_PER_DOLLAR;
  // Sub-cent amounts would otherwise all render as "$0.00".
  return `$${dollars.toFixed(value > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function windowLabel(allowance: UsageAllowance): string {
  switch (allowance.windowKind) {
    case 'rolling':
      return `rolling ${allowance.windowHours ?? 24}h`;
    case 'daily':
      return 'today';
    case 'weekly':
      return 'this week';
    case 'monthly':
      return 'this month';
    default:
      return '';
  }
}

function AllowanceMeter({ allowance }: { allowance: UsageAllowance }) {
  // The bar depletes as the allowance is consumed, so a full bar means a full
  // allowance remaining.
  const percentRemaining = Math.max(0, 100 - (allowance.used / allowance.limitValue) * 100);
  const low = percentRemaining <= 10;
  const countdown = formatCountdown(allowance.resetsAt);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-[var(--text-secondary)]">{allowance.name}</span>
        <span
          className={cn(
            'shrink-0 text-xs',
            low ? 'text-[var(--danger-foreground)]' : 'text-[var(--text-muted)]',
          )}
        >
          {formatAmount(allowance.remaining, allowance.metric)} left
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
      <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
        {formatAmount(allowance.used, allowance.metric)} of{' '}
        {formatAmount(allowance.limitValue, allowance.metric)} · {windowLabel(allowance)}
        {countdown ? ` · resets in ${countdown}` : ''}
      </p>
    </div>
  );
}

/**
 * Usage meter for the settings rail. Quota policies are optional, so this also
 * reports plain consumption when none apply to the signed-in role.
 */
export function UsageLimits() {
  const { data } = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.get<UsageSummary>('/me/usage'),
    staleTime: 30_000,
  });

  if (!data) return null;

  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <p className="text-sm font-semibold">Usage Limits</p>
        <Info
          className="size-3.5 text-[var(--text-muted)]"
          aria-label={
            data.allowances.length > 0
              ? 'Consumption against each quota policy applied to your role'
              : 'Your usage over the last 24 hours'
          }
        />
      </div>

      {data.allowances.length > 0 ? (
        <div className="flex flex-col gap-3">
          {data.allowances.map((allowance) => (
            <AllowanceMeter key={allowance.policyId} allowance={allowance} />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
            <div className="flex justify-between">
              <span>Messages</span>
              <span className="text-[var(--text-muted)]">
                {data.recent.messages.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Tokens</span>
              <span className="text-[var(--text-muted)]">
                {data.recent.tokens.toLocaleString()}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-[var(--text-muted)]">No limits applied · last 24h</p>
        </>
      )}
    </div>
  );
}
