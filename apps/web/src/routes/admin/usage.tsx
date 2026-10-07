import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import {
  DEFAULT_USAGE_RANGE,
  DEFAULT_USAGE_TAB,
  USAGE_RANGES,
  type UsageRange,
  type UsageTab,
  validateUsageSearch,
} from '~/lib/admin-search';
import { LimitsTab } from './usage/limits-tab';
import { OverviewTab } from './usage/overview-tab';
import { SpendTab } from './usage/spend-tab';
import { StorageTab } from './usage/storage-tab';

export { fillDays, money } from './usage/usage-helpers';

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
