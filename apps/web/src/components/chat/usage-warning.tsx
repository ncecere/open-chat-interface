import { MICROS_PER_DOLLAR, type UsageAllowance, type UsageSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

function formatAmount(value: number, metric: UsageAllowance['metric']): string {
  if (metric !== 'cost') return value.toLocaleString();
  const dollars = value / MICROS_PER_DOLLAR;
  return `$${dollars.toFixed(value > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function metricNoun(allowance: UsageAllowance): string {
  switch (allowance.metric) {
    case 'messages':
      return 'messages';
    case 'tokens':
      return 'tokens';
    default:
      return 'budget';
  }
}

function resetLabel(allowance: UsageAllowance): string {
  if (!allowance.resetsAt) return '';
  const remaining = new Date(allowance.resetsAt).getTime() - Date.now();
  if (remaining <= 0) return '';

  const hours = Math.ceil(remaining / 3_600_000);
  if (hours >= 24) return ` Resets in ${Math.ceil(hours / 24)} day${hours >= 48 ? 's' : ''}.`;
  return ` Resets in ${hours} hour${hours === 1 ? '' : 's'}.`;
}

/**
 * Warns before a user is cut off rather than after.
 *
 * Placed next to the composer instead of in a global banner: this is where the
 * limit will actually bite, and where the user can act on it. Severity is
 * computed server-side so this cannot disagree with enforcement.
 */
export function UsageWarning() {
  const [dismissed, setDismissed] = useState<Record<string, UsageAllowance['severity']>>({});

  const { data } = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.get<UsageSummary>('/me/usage'),
    staleTime: 30_000,
  });

  const pressing = (data?.allowances ?? [])
    .filter((allowance) => allowance.severity !== 'ok')
    // A dismissal covers the severity it was made at, so crossing into a worse
    // state surfaces the warning again.
    .filter((allowance) => dismissed[allowance.policyId] !== allowance.severity);

  if (pressing.length === 0) return null;

  // One message at a time; the most urgent allowance is the actionable one.
  const order: Record<UsageAllowance['severity'], number> = {
    exceeded: 0,
    critical: 1,
    warning: 2,
    ok: 3,
  };
  const allowance = [...pressing].sort((a, b) => order[a.severity] - order[b.severity])[0];
  if (!allowance) return null;

  const exceeded = allowance.severity === 'exceeded';
  const scoped = allowance.modelSlugs.length > 0;

  const message = exceeded
    ? `You have used all of your ${allowance.name} ${metricNoun(allowance)}.${
        scoped ? ' Other models are still available.' : ''
      }${resetLabel(allowance)}`
    : `${formatAmount(allowance.remaining, allowance.metric)} of your ${allowance.name} ${metricNoun(allowance)} remaining.${resetLabel(allowance)}`;

  return (
    <div
      role="status"
      className={cn(
        'mx-auto mb-2 flex w-full max-w-3xl items-start gap-2.5 rounded-xl border px-3 py-2 text-xs',
        exceeded || allowance.severity === 'critical'
          ? 'border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger-foreground)]'
          : 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-secondary)]',
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        aria-label="Dismiss usage warning"
        onClick={() =>
          setDismissed((current) => ({ ...current, [allowance.policyId]: allowance.severity }))
        }
        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
