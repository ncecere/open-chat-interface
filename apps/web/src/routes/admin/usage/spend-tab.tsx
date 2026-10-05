import { DELETED_ACCOUNTS_LABEL } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Notice, SettingsSection } from '~/components/admin/admin-ui';
import { LabLogo } from '~/components/model/lab-logo';
import { Badge } from '~/components/ui/badge';
import { api } from '~/lib/api-client';
import { compact, money, type SpendResponse } from './usage-helpers';
import { PeopleList, StatGrid, TabPending, Trend, TruncationNote } from './usage-ui';

export function SpendTab({ days }: { days: number }) {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'spend', days],
    queryFn: () => api.get<SpendResponse>(`/admin/usage/spend?days=${days}`),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Spend could not be loaded." />;

  return (
    <div className="flex flex-col gap-10">
      <StatGrid
        stats={[
          { label: 'Spend', value: money(data.totals.costMicros) },
          { label: 'Messages', value: compact(data.totals.messages) },
          { label: 'Tokens', value: compact(data.totals.tokens) },
          { label: 'People', value: String(data.totals.activeUsers) },
        ]}
      />

      <SettingsSection
        title="Spend over time"
        description={`Daily totals, with days ending at midnight ${data.range.timezone}.`}
      >
        <Trend
          label="Daily spend"
          range={data.range}
          points={data.daily.map((entry) => ({ day: entry.day, value: entry.costMicros }))}
          describe={(point) => `${point.day} · ${money(point.value)}`}
        />
      </SettingsSection>

      <SettingsSection
        title="By model"
        description="Where the consumption goes, and how often a model failed to answer."
      >
        {data.models.entries.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">Nothing recorded in this range.</p>
        ) : (
          <section
            // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
            tabIndex={0}
            aria-label="Usage by model"
            className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
          >
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-[var(--border-subtle)] border-b text-left text-[var(--text-muted)] text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Messages</th>
                  <th className="px-4 py-3 font-medium">Tokens</th>
                  <th className="px-4 py-3 font-medium">Spend</th>
                  <th className="px-4 py-3 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {data.models.entries.map((model) => (
                  <tr
                    key={model.modelSlug}
                    className="border-[var(--border-subtle)] border-b last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <LabLogo labId={model.labId} />
                        <span className="truncate" title={model.displayName ?? model.modelSlug}>
                          {model.displayName ?? model.modelSlug}
                        </span>
                        {model.enabled === false && <Badge variant="outline">disabled</Badge>}
                        {model.enabled === null && <Badge variant="outline">not in catalog</Badge>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {compact(model.messages)}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {compact(model.tokens)}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {money(model.costMicros)}
                    </td>
                    <td className="px-4 py-3">
                      {model.errors > 0 ? (
                        <span className="text-[var(--danger-on-tint)]">{model.errors}</span>
                      ) : (
                        <span className="text-[var(--text-muted)]">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TruncationNote
              shown={data.models.entries.length}
              total={data.models.totalCount}
              noun="models used"
            />
          </section>
        )}
      </SettingsSection>

      <SettingsSection
        title="Top consumers"
        description="Who is using the most. Identity and volume only; conversations are never shown here. Usage of deleted accounts is kept as one row."
      >
        <PeopleList
          entries={data.consumers.entries.map((consumer) => ({
            userId: consumer.userId ?? 'deleted-accounts',
            name: consumer.deleted ? DELETED_ACCOUNTS_LABEL : consumer.name,
            email: consumer.email ?? 'Kept without the people they belonged to',
            primary: money(consumer.costMicros),
            secondary: `${compact(consumer.messages)} messages`,
          }))}
        />
        <TruncationNote
          shown={data.consumers.entries.length}
          total={data.consumers.totalCount}
          noun="people"
        />
      </SettingsSection>

      <SettingsSection
        title="Unused models"
        description="Enabled in the catalog but not chosen by anyone in this range."
      >
        {data.idleModels.entries.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">Every enabled model was used.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.idleModels.entries.map((model) => (
              <span
                key={model.slug}
                className="flex items-center gap-1.5 rounded-full bg-[var(--bg-control-alt)] px-3 py-1 text-xs"
              >
                <LabLogo labId={model.labId} />
                {model.displayName}
              </span>
            ))}
          </div>
        )}
        <TruncationNote
          shown={data.idleModels.entries.length}
          total={data.idleModels.totalCount}
          noun="unused models"
        />
      </SettingsSection>

      {!data.range.exact && (
        <Notice title="This range reaches past detailed history">
          Per-message records are kept for a limited time, so days beyond that are grouped in UTC
          rather than {data.range.timezone}.
        </Notice>
      )}
    </div>
  );
}
