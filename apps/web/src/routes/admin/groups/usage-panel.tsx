import type { AdminGroupDetail, GroupUsage } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LoadError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { ADMIN_GROUPS_KEY, formatCost } from '~/lib/groups';
import { formatNumber } from '~/lib/i18n/format';
import { cn, formatDate } from '~/lib/utils';

const RANGES = [7, 30, 90] as const;
const number = (value: number) => formatNumber(value);

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-[var(--text-muted)] text-xs uppercase tracking-wide">{label}</dt>
      <dd className="mt-1 font-semibold text-lg">{value}</dd>
    </div>
  );
}

/**
 * Usage by the group's people as they are today, not a historical label:
 * someone who left is not counted and someone who joined brings their past.
 */
export function UsagePanel({ group }: { group: AdminGroupDetail }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const usage = useQuery({
    queryKey: [...ADMIN_GROUPS_KEY, 'usage', group.id, days],
    queryFn: () => api.get<GroupUsage>(`/admin/groups/${group.id}/usage?days=${days}`),
    placeholderData: (previous) => previous,
  });
  const data = usage.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[var(--text-muted)] text-sm" aria-live="polite">
          Use by the group’s current members over the last {days} days. People who have left the
          group are not counted, and people who joined bring their earlier use.
        </p>
        <fieldset
          aria-label="Period"
          className="m-0 inline-flex min-w-0 gap-1 rounded-xl border-0 bg-[var(--bg-segment-track)] p-1"
        >
          {RANGES.map((range) => (
            <Button
              key={range}
              type="button"
              variant={null}
              size={null}
              aria-pressed={days === range}
              onClick={() => setDays(range)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                days === range
                  ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              Last {range} days
            </Button>
          ))}
        </fieldset>
      </div>

      {usage.isLoading ? (
        <div role="status" aria-label="Loading usage" className="py-10">
          <Spinner className="mx-auto size-5" />
        </div>
      ) : !data ? (
        <LoadError title="Usage could not be loaded." query={usage} />
      ) : (
        <>
          <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] sm:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-s sm:[&>*:nth-child(n+2)]:border-s [&>*:nth-child(n+3)]:border-t sm:[&>*:nth-child(n+3)]:border-t-0">
            <Figure label="Messages" value={number(data.totals.messages)} />
            <Figure label="Tokens in" value={number(data.totals.tokensIn)} />
            <Figure label="Tokens out" value={number(data.totals.tokensOut)} />
            <Figure label="Cost" value={formatCost(data.totals.costMicros)} />
          </dl>
          <p className="text-[var(--text-muted)] text-xs">
            {number(data.memberCount)} current {data.memberCount === 1 ? 'member' : 'members'},
            since {formatDate(data.since)}.
          </p>

          {data.people.length === 0 ? (
            <p className="text-[var(--text-muted)] text-sm">
              No one in the group has used it in this period.
            </p>
          ) : (
            <section
              // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
              tabIndex={0}
              aria-label="Usage by person"
              className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
            >
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="bg-[var(--bg-control-alt)] text-[var(--text-muted)] text-xs">
                  <tr>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      Person
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      Messages
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      Tokens in
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      Tokens out
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((person) => (
                    <tr key={person.userId} className="border-[var(--border-subtle)] border-t">
                      <td className="px-4 py-2">
                        <span className="font-medium">{person.name}</span>{' '}
                        <span className="text-[var(--text-muted)] text-xs">{person.email}</span>
                      </td>
                      <td className="px-4 py-2 text-end">{number(person.messages)}</td>
                      <td className="px-4 py-2 text-end">{number(person.tokensIn)}</td>
                      <td className="px-4 py-2 text-end">{number(person.tokensOut)}</td>
                      <td className="px-4 py-2 text-end">{formatCost(person.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {data.truncated && (
            <p className="text-[var(--text-muted)] text-xs">
              Only the busiest people are listed; the totals above include everyone.
            </p>
          )}
        </>
      )}
    </div>
  );
}
