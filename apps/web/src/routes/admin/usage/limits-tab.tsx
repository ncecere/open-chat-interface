import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { api } from '~/lib/api-client';
import type { LimitsResponse } from './usage-helpers';
import { TabPending, TruncationNote } from './usage-ui';

export function LimitsTab({ days }: { days: number }) {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'limits', days],
    queryFn: () => api.get<LimitsResponse>(`/admin/usage/limits?days=${days}`),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Limit activity could not be loaded." />;

  return (
    <SettingsSection
      title="Limit denials"
      description="Runs a limit refused. Denials spread across many people usually mean a limit is set too low rather than that anyone is misbehaving."
    >
      {data.denials.entries.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">
          No one was stopped by a limit in this range.
        </p>
      ) : (
        <section
          // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
          tabIndex={0}
          aria-label="Limit refusals"
          className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
        >
          {data.denials.entries.map((denial) => (
            <div
              key={`${denial.policyId}-${denial.policyName}`}
              className="flex items-center justify-between gap-4 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-sm" title={denial.policyName}>
                  {denial.policyName}
                </p>
                <p className="text-[var(--text-muted)] text-xs">
                  {denial.usersAffected} {denial.usersAffected === 1 ? 'person' : 'people'} affected
                </p>
              </div>
              <Badge variant={denial.usersAffected > 1 ? 'warning' : 'neutral'}>
                {denial.denials.toLocaleString()} refused
              </Badge>
            </div>
          ))}
        </section>
      )}
      <TruncationNote
        shown={data.denials.entries.length}
        total={data.denials.totalCount}
        noun="limits"
      />
    </SettingsSection>
  );
}
