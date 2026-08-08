import { MICROS_PER_DOLLAR, type UsageAllowance, type UsageSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '~/lib/api-client';

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
 * A toast rather than an inline banner: the warning is worth interrupting for
 * once, but it should not permanently occupy space above the composer or
 * outgrow the input it sits over.
 *
 * Severity is computed server-side so this cannot disagree with enforcement.
 */
export function UsageWarning() {
  // Remembers the severity each policy was last announced at, so crossing into
  // a worse state warns again while ordinary polling stays silent.
  const announced = useRef(new Map<string, UsageAllowance['severity']>());

  const { data } = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.get<UsageSummary>('/me/usage'),
    staleTime: 30_000,
  });

  useEffect(() => {
    for (const allowance of data?.allowances ?? []) {
      if (allowance.severity === 'ok') {
        // Recovered, most likely because the window rolled over. Clear the
        // record so the next approach warns again.
        announced.current.delete(allowance.policyId);
        continue;
      }

      if (announced.current.get(allowance.policyId) === allowance.severity) continue;
      announced.current.set(allowance.policyId, allowance.severity);

      const exceeded = allowance.severity === 'exceeded';
      const scoped = allowance.modelSlugs.length > 0;

      const description = exceeded
        ? `${scoped ? 'Other models are still available.' : ''}${resetLabel(allowance)}`.trim()
        : `${formatAmount(allowance.remaining, allowance.metric)} remaining.${resetLabel(allowance)}`;

      const message = exceeded
        ? `You have used all of your ${allowance.name} ${metricNoun(allowance)}.`
        : `You are close to your ${allowance.name} limit.`;

      const options = { id: `usage-${allowance.policyId}`, description };

      if (exceeded || allowance.severity === 'critical') toast.error(message, options);
      else toast.warning(message, options);
    }
  }, [data]);

  return null;
}
