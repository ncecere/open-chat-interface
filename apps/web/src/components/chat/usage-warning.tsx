import type { QuotaMetric, QuotaWindowKind, UsageAllowance, UsageSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '~/lib/api-client';
import { translate } from '~/lib/i18n';

/**
 * Warns before a user is cut off rather than after.
 *
 * A toast rather than an inline banner: worth interrupting for once, but it
 * should not permanently occupy space above the composer.
 *
 * The message carries no numbers at all. A toast is an interruption, so it
 * only needs to say that attention is warranted and which limit is involved;
 * the meter in settings is where someone goes to see how much is left.
 *
 * Severity is computed server-side so this cannot disagree with enforcement.
 */
/** What a limit counts, as the sentence names it (the shared English helpers are not translated). */
function limitName(metric: QuotaMetric): string {
  switch (metric) {
    case 'messages':
      return translate('chat.usageWarning.limitMessages');
    case 'tokens':
      return translate('chat.usageWarning.limitTokens');
    default:
      return translate('chat.usageWarning.limitUsage');
  }
}

/** "for today", "for the last 24 hours". */
function windowPhrase(windowKind: QuotaWindowKind, windowHours: number | null): string {
  switch (windowKind) {
    case 'rolling':
      return translate('chat.usageWarning.windowHours', { hours: windowHours ?? 24 });
    case 'daily':
      return translate('chat.usageWarning.windowToday');
    case 'weekly':
      return translate('chat.usageWarning.windowWeek');
    case 'monthly':
      return translate('chat.usageWarning.windowMonth');
    default:
      return translate('chat.usageWarning.windowOther');
  }
}

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
      const options = {
        id: `usage-${allowance.policyId}`,
        description:
          exceeded && allowance.modelSlugs.length > 0
            ? translate('chat.usageWarning.otherModels')
            : undefined,
      };

      // Not the policy's name, which is the administrator's (#93).
      const sentence = {
        limit: limitName(allowance.metric),
        window: windowPhrase(allowance.windowKind, allowance.windowHours),
      };
      const message = translate(
        exceeded ? 'chat.usageWarning.reached' : 'chat.usageWarning.approaching',
        sentence,
      );

      if (exceeded || allowance.severity === 'critical') toast.error(message, options);
      else toast.warning(message, options);
    }
  }, [data]);

  return null;
}
