import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from '~/components/admin/admin-ui';
import { api } from '~/lib/api-client';
import { compact, type OverviewResponse } from './usage-helpers';
import { StatGrid, TabPending, Trend } from './usage-ui';

export function OverviewTab({ days }: { days: number }) {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'overview', days],
    queryFn: () => api.get<OverviewResponse>(`/admin/usage/overview?days=${days}`),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Usage overview could not be loaded." />;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <StatGrid
          stats={[
            { label: 'Conversations', value: compact(data.activity.threadsCreated) },
            { label: 'Messages sent', value: compact(data.activity.messagesSent) },
            { label: 'People active', value: String(data.totals.activeUsers) },
            { label: 'Attachments', value: compact(data.activity.attachmentsUploaded) },
          ]}
        />
        {/* These count rows still stored, the usage figures count usage records,
          which outlive deletion: the gap is mostly deleted conversations, not
          regenerations as the caption said (#262). */}
        <p className="text-[var(--text-muted)] text-xs leading-relaxed">
          Conversations, messages sent and attachments count what is still stored: anything deleted
          since is not counted. Replies and the Spend tab come from usage records, which are kept
          when conversations or accounts are deleted.
        </p>
      </div>

      <SettingsSection
        title="Activity over time"
        description={`Replies generated per day, from the usage records, with days ending at midnight ${data.range.timezone}. Each regeneration is a reply, and replies in conversations deleted since still count, so this can exceed Messages sent.`}
      >
        <Trend
          label="Daily replies"
          range={data.range}
          points={data.daily.map((entry) => ({ day: entry.day, value: entry.messages }))}
          describe={(point) =>
            `${point.day} · ${point.value.toLocaleString()} ${point.value === 1 ? 'reply' : 'replies'}`
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Feature use"
        description="Which capabilities people actually reach for."
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          {[
            { label: 'Web searches', value: data.activity.searchesRun },
            { label: 'Branches and forks', value: data.activity.branchesCreated },
            { label: 'Shared links', value: data.activity.sharesCreated },
            { label: 'Temporary chats', value: data.activity.temporaryThreads },
            { label: 'Failed responses', value: data.activity.erroredResponses },
            { label: 'Stopped early', value: data.activity.cancelledResponses },
          ].map((entry) => (
            <div
              key={entry.label}
              className="flex items-baseline justify-between gap-3 border-[var(--border-subtle)] border-b pb-3"
            >
              <dt className="text-[var(--text-secondary)] text-sm">{entry.label}</dt>
              <dd className="font-medium text-sm">{compact(entry.value)}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </div>
  );
}
