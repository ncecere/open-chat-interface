import type { UsageAllowance, UsageSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api } from '~/lib/api-client';
import { type MessageKey, type Translate, useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

function formatCountdown(iso: string | null, t: Translate): string | null {
  if (!iso) return null;
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return null;

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours >= 24) {
    return t('settings.usage.durationDaysHours', {
      days: Math.floor(hours / 24),
      hours: hours % 24,
    });
  }
  return hours > 0
    ? t('settings.usage.durationHoursMinutes', { hours, minutes })
    : t('settings.usage.durationMinutes', { minutes });
}

function windowLabel(allowance: UsageAllowance, t: Translate): string {
  switch (allowance.windowKind) {
    case 'rolling':
      return t('settings.usage.windowRolling', { hours: allowance.windowHours ?? 24 });
    case 'daily':
      return t('settings.usage.windowDaily');
    case 'weekly':
      return t('settings.usage.windowWeekly');
    case 'monthly':
      return t('settings.usage.windowMonthly');
    default:
      return '';
  }
}

/** What is counted: the limit's kind, not the policy's name (the administrator's). */
const LIMIT_NAMES: Record<string, { all: MessageKey; some: MessageKey }> = {
  messages: {
    all: 'settings.usage.limitMessages',
    some: 'settings.usage.limitMessagesSomeModels',
  },
  tokens: { all: 'settings.usage.limitTokens', some: 'settings.usage.limitTokensSomeModels' },
};
const OTHER_LIMIT_NAME = {
  all: 'settings.usage.limitUsage',
  some: 'settings.usage.limitUsageSomeModels',
} as const;

/**
 * Shows only how much of an allowance is left, as a percentage.
 *
 * Messages, tokens, and spend are three different units, and the raw numbers
 * mean little to the person reading them. A percentage answers the only
 * question they actually have, reads the same for every metric, and keeps
 * instance cost out of the interface.
 */
function AllowanceMeter({ allowance }: { allowance: UsageAllowance }) {
  const t = useT();
  // The bar depletes as the allowance is consumed, so a full bar means a full
  // allowance remaining.
  const fractionRemaining = Math.max(0, 1 - allowance.used / allowance.limitValue);
  // Severity comes from the server so the meter and the toast cannot disagree
  // about when a user is close to their limit.
  const low = allowance.severity === 'critical' || allowance.severity === 'exceeded';
  const countdown = formatCountdown(allowance.resetsAt, t);
  const names = LIMIT_NAMES[allowance.metric] ?? OTHER_LIMIT_NAME;
  const label = t(allowance.modelSlugs.length > 0 ? names.some : names.all);

  // Round toward zero so a nearly spent allowance never reads as a full 1%,
  // but anything still usable stays visible rather than showing 0%.
  const percentRemaining =
    fractionRemaining > 0 ? Math.max(1, Math.floor(fractionRemaining * 100)) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        {/* What is counted, not the policy's name, which is the
            administrator's (#93); in full on hover if the rail cuts it. */}
        <span
          className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-sm text-[var(--text-secondary)]"
          title={label}
        >
          {label}
        </span>
        <span
          className={cn(
            'shrink-0 text-xs',
            low ? 'text-[var(--danger-on-tint)]' : 'text-[var(--text-muted)]',
          )}
        >
          {t('settings.usage.percentLeft', { fraction: percentRemaining / 100 })}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--bg-segment-track)]">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            low ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]',
          )}
          style={{ width: `${fractionRemaining * 100}%` }}
        />
      </div>
      <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
        {countdown
          ? t('settings.usage.windowResets', {
              window: windowLabel(allowance, t),
              time: countdown,
            })
          : windowLabel(allowance, t)}
      </p>
    </div>
  );
}

/**
 * Usage meter for the settings rail. Quota policies are optional, so this also
 * reports plain consumption when none apply to the signed-in role.
 */
export function UsageLimits() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.get<UsageSummary>('/me/usage'),
    staleTime: 30_000,
  });

  if (!data) return null;

  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        {/* A heading, as the other cards' titles are (#272). */}
        <h2 className="text-sm font-semibold">{t('settings.usage.title')}</h2>
        <Info
          className="size-3.5 text-[var(--text-muted)]"
          aria-label={
            data.allowances.length > 0
              ? t('settings.usage.infoWithLimits')
              : t('settings.usage.infoNoLimits')
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
        <p className="text-sm text-[var(--text-muted)]">{t('settings.usage.none')}</p>
      )}
    </div>
  );
}
