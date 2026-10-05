import { DELETED_ACCOUNTS_LABEL, MICROS_PER_DOLLAR } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader, LoadError, Notice, SettingsSection } from '~/components/admin/admin-ui';
import { LabLogo } from '~/components/model/lab-logo';
import { Badge } from '~/components/ui/badge';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import {
  DEFAULT_USAGE_RANGE,
  DEFAULT_USAGE_TAB,
  USAGE_RANGES,
  type UsageRange,
  type UsageTab,
  validateUsageSearch,
} from '~/lib/admin-search';
import { api } from '~/lib/api-client';

interface Range {
  days: number;
  timezone: string;
  exact: boolean;
}

interface Totals {
  messages: number;
  tokens: number;
  costMicros: number;
  activeUsers: number;
}

interface OverviewResponse {
  range: Range;
  totals: Totals;
  activity: {
    threadsCreated: number;
    messagesSent: number;
    attachmentsUploaded: number;
    sharesCreated: number;
    searchesRun: number;
    branchesCreated: number;
    temporaryThreads: number;
    erroredResponses: number;
    cancelledResponses: number;
  };
  daily: Array<{ day: string; messages: number; activeUsers: number }>;
}

/** A capped list plus the true total, so a truncated view can say so. */
interface Bounded<T> {
  entries: T[];
  totalCount: number;
}

interface SpendResponse {
  range: Range;
  totals: Totals;
  daily: Array<{ day: string; messages: number; tokens: number; costMicros: number }>;
  models: Bounded<{
    modelSlug: string;
    displayName: string | null;
    labId: string | null;
    /** Null when not in the chat catalog (an embedding model, or one since removed). */
    enabled: boolean | null;
    messages: number;
    tokens: number;
    costMicros: number;
    errors: number;
  }>;
  /** `deleted` is the one row for every deleted account's usage (no identity). */
  consumers: Bounded<{
    deleted: boolean;
    userId: string | null;
    name: string;
    email: string | null;
    messages: number;
    costMicros: number;
  }>;
  idleModels: Bounded<{ slug: string; displayName: string; labId: string | null }>;
}

interface LimitsResponse {
  range: Range;
  denials: Bounded<{
    policyId: string | null;
    policyName: string;
    denials: number;
    usersAffected: number;
  }>;
}

interface StorageResponse {
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
  topUsers: Array<{ userId: string; name: string; email: string; bytes: number; files: number }>;
  totalUsers: number;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'spend', label: 'Spend' },
  { id: 'limits', label: 'Limits' },
  { id: 'storage', label: 'Storage' },
] as const satisfies readonly PillTab<UsageTab>[];

type RangeTabId = `${UsageRange}`;

const RANGE_TABS: readonly PillTab<RangeTabId>[] = USAGE_RANGES.map((range) => ({
  id: `${range}` as RangeTabId,
  label: `${range} days`,
}));

function money(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  return `$${dollars.toFixed(micros > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function bytes(value: number): string {
  const MB = 1024 * 1024;
  if (value >= 1024 * MB) return `${(value / (1024 * MB)).toFixed(2)} GB`;
  if (value >= MB) return `${(value / MB).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

function StatGrid({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="min-w-0 rounded-xl border border-[var(--border-subtle)] p-4"
        >
          <dt className="truncate text-[var(--text-muted)] text-xs">{stat.label}</dt>
          <dd className="mt-1 truncate font-semibold text-xl">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** YYYY-MM-DD for `date` in `timeZone`. */
function dayIn(timeZone: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Every day of the range, oldest first, with days that recorded nothing as 0.
 * The API returns only days with data, which drew one active day as a block
 * filling the whole 30-day chart, both axis labels the same date.
 */
export function fillDays(
  points: Array<{ day: string; value: number }>,
  days: number,
  endDay: string,
): Array<{ day: string; value: number }> {
  const values = new Map(points.map((point) => [point.day, point.value]));
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (Number.isNaN(end) || days < 1) return points;
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, value: values.get(day) ?? 0 };
  });
}

/**
 * A daily trend drawn as plain bars.
 *
 * A charting dependency would be a lot of weight for this; the project already
 * draws its usage meters the same way. The bars are a picture: its name says
 * the total and the busiest day, and "Show the numbers" lists every day for
 * keyboard, touch and screen-reader users.
 */
function Trend({
  points,
  range,
  label,
  describe,
}: {
  points: Array<{ day: string; value: number }>;
  range: Range;
  label: string;
  describe: (point: { day: string; value: number }) => string;
}) {
  if (points.length === 0) {
    return <p className="text-[var(--text-muted)] text-sm">Nothing recorded in this range.</p>;
  }

  const filled = fillDays(points, range.days, dayIn(range.timezone, new Date()));
  const peak = Math.max(1, ...filled.map((point) => point.value));
  const busiest = filled.reduce((best, point) => (point.value > best.value ? point : best));
  const active = filled.filter((point) => point.value > 0);

  return (
    <div>
      <div
        className="flex h-32 items-end gap-0.5"
        role="img"
        aria-label={`${label}, ${filled[0]?.day} to ${filled.at(-1)?.day}: busiest ${describe(busiest)}; ${active.length} of ${filled.length} days had any.`}
      >
        {filled.map((point) => (
          <div
            key={point.day}
            className="group relative min-w-0 flex-1 rounded-t bg-[var(--accent)]/70 transition-colors hover:bg-[var(--accent)]"
            style={{
              height: point.value > 0 ? `${Math.max(2, (point.value / peak) * 100)}%` : '0',
            }}
          >
            <span className="-translate-x-1/2 pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden whitespace-nowrap rounded bg-[var(--bg-control-hover)] px-2 py-1 text-[10px] group-hover:block">
              {describe(point)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[var(--text-muted)] text-xs">
        <span>{filled[0]?.day}</span>
        <span>{filled.at(-1)?.day}</span>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[var(--text-secondary)]">Show the numbers</summary>
        <table className="mt-2 text-sm">
          <caption className="sr-only">{label}, days with any</caption>
          <tbody>
            {active.map((point) => (
              <tr key={point.day}>
                <td className="py-0.5 pr-6 text-[var(--text-muted)]">{point.day}</td>
                <td className="py-0.5">{describe(point).split(' · ').at(-1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[var(--text-muted)] text-xs">Days not listed had none.</p>
      </details>
    </div>
  );
}

/** States what a capped list left out, so a partial view never reads as whole. */
function TruncationNote({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;
  return (
    <p className="mt-2 text-[var(--text-muted)] text-xs">
      Showing the top {shown} of {total.toLocaleString()} {noun}.
    </p>
  );
}

function PeopleList({
  entries,
}: {
  entries: Array<{
    userId: string;
    name: string;
    email: string;
    primary: string;
    secondary: string;
  }>;
}) {
  if (entries.length === 0) {
    return <p className="text-[var(--text-muted)] text-sm">Nothing recorded in this range.</p>;
  }

  return (
    <div className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
      {entries.map((entry) => (
        <div
          key={entry.userId}
          className="flex items-center justify-between gap-4 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{entry.name}</p>
            <p className="truncate text-[var(--text-muted)] text-xs">{entry.email}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm">{entry.primary}</p>
            <p className="text-[var(--text-muted)] text-xs">{entry.secondary}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A tab's spinner, or a retryable error once its query has failed. */
function TabPending({
  query,
  title,
}: {
  query: { error: unknown; isError: boolean; isFetching: boolean; refetch: () => unknown };
  title: string;
}) {
  if (query.isError) return <LoadError title={title} query={query} />;
  return (
    <div role="status" aria-label="Loading">
      <Spinner className="mx-auto size-6" />
    </div>
  );
}

function OverviewTab({ days }: { days: number }) {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'overview', days],
    queryFn: () => api.get<OverviewResponse>(`/admin/usage/overview?days=${days}`),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Usage overview could not be loaded." />;

  return (
    <div className="flex flex-col gap-10">
      <StatGrid
        stats={[
          { label: 'Conversations', value: compact(data.activity.threadsCreated) },
          { label: 'Messages sent', value: compact(data.activity.messagesSent) },
          { label: 'People active', value: String(data.totals.activeUsers) },
          { label: 'Attachments', value: compact(data.activity.attachmentsUploaded) },
        ]}
      />

      <SettingsSection
        title="Activity over time"
        description={`Replies generated per day (regenerations included, so this can exceed Messages sent), with days ending at midnight ${data.range.timezone}.`}
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

function SpendTab({ days }: { days: number }) {
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
          <div className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
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
                        <span className="truncate">{model.displayName ?? model.modelSlug}</span>
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
          </div>
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

function LimitsTab({ days }: { days: number }) {
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
        <div className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
          {data.denials.entries.map((denial) => (
            <div
              key={`${denial.policyId}-${denial.policyName}`}
              className="flex items-center justify-between gap-4 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{denial.policyName}</p>
                <p className="text-[var(--text-muted)] text-xs">
                  {denial.usersAffected} {denial.usersAffected === 1 ? 'person' : 'people'} affected
                </p>
              </div>
              <Badge variant={denial.usersAffected > 1 ? 'warning' : 'neutral'}>
                {denial.denials.toLocaleString()} refused
              </Badge>
            </div>
          ))}
        </div>
      )}
      <TruncationNote
        shown={data.denials.entries.length}
        total={data.denials.totalCount}
        noun="limits"
      />
    </SettingsSection>
  );
}

function StorageTab() {
  const query = useQuery({
    queryKey: ['admin', 'usage', 'storage'],
    queryFn: () => api.get<StorageResponse>('/admin/usage/storage'),
  });
  const { data } = query;

  if (!data) return <TabPending query={query} title="Storage usage could not be loaded." />;

  return (
    <div className="flex flex-col gap-10">
      <StatGrid
        stats={[
          { label: 'In use', value: bytes(data.liveBytes) },
          { label: 'Files', value: compact(data.liveFileCount) },
          { label: 'Pending deletion', value: bytes(data.pendingBytes) },
          { label: 'In trash', value: compact(data.pendingFileCount) },
        ]}
      />

      <SettingsSection
        title="By person"
        description="Who is holding the most. Deleted files are excluded; they no longer count against anyone's allowance."
      >
        <PeopleList
          entries={data.topUsers.map((entry) => ({
            userId: entry.userId,
            name: entry.name,
            email: entry.email,
            primary: bytes(entry.bytes),
            secondary: `${compact(entry.files)} files`,
          }))}
        />
        <TruncationNote
          shown={data.topUsers.length}
          total={data.totalUsers}
          noun="people holding files"
        />
      </SettingsSection>
    </div>
  );
}

export function AdminUsagePage() {
  const navigate = useNavigate();
  const search = validateUsageSearch(useSearch({ strict: false }));
  const tab = search.tab ?? DEFAULT_USAGE_TAB;
  const days = search.range ?? DEFAULT_USAGE_RANGE;

  // Defaults stay out of the URL so the plain /admin/usage link is canonical.
  function show(next: { tab?: UsageTab; range?: UsageRange }) {
    const nextTab = next.tab ?? tab;
    const nextRange = next.range ?? days;
    void navigate({
      to: '/admin/usage',
      search: {
        tab: nextTab === DEFAULT_USAGE_TAB ? undefined : nextTab,
        range: nextRange === DEFAULT_USAGE_RANGE ? undefined : nextRange,
      },
      replace: true,
    });
  }

  return (
    <div>
      <AdminPageHeader
        title="Usage"
        description="What this instance is actually doing. Every figure here is a count or a total; nothing reads conversation content."
        actions={
          // Storage is a gauge rather than a flow, so a range would not mean
          // anything on that tab.
          tab === 'storage' ? undefined : (
            <PillTabs
              tabs={RANGE_TABS}
              active={String(days) as RangeTabId}
              onChange={(range) => show({ range: Number(range) as UsageRange })}
              label="Reporting range"
              controls={`panel-${tab}`}
            />
          )
        }
      />

      <PillTabs
        tabs={TABS}
        active={tab}
        onChange={(next) => show({ tab: next })}
        label="Usage sections"
      />

      <div className="mt-8 pb-10" id={`panel-${tab}`} role="tabpanel">
        {tab === 'overview' && <OverviewTab days={days} />}
        {tab === 'spend' && <SpendTab days={days} />}
        {tab === 'limits' && <LimitsTab days={days} />}
        {tab === 'storage' && <StorageTab />}
      </div>
    </div>
  );
}
