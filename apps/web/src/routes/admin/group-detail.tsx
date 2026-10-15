import type { AdminGroupDetail } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { AdminPageHeader, LoadError } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { FullPageSpinner } from '~/components/ui/spinner';
import {
  DEFAULT_GROUP_TAB,
  GROUP_TABS,
  type GroupTab,
  validateGroupSearch,
} from '~/lib/admin-search';
import { api } from '~/lib/api-client';
import { pageWithin, usePageTitle } from '~/lib/document-title';
import { groupDetailKey } from '~/lib/groups';
import { plural } from '~/lib/utils';
import { GrantsPanel } from './groups/grants-panel';
import { MembersPanel } from './groups/members-panel';
import { SettingsPanel } from './groups/settings-panel';
import { UsagePanel } from './groups/usage-panel';

const TAB_LABELS: Record<GroupTab, string> = {
  members: 'Members',
  grants: 'Budgets and models',
  usage: 'Usage',
  settings: 'Settings',
};

const TABS = GROUP_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
})) satisfies readonly PillTab<GroupTab>[];

/**
 * One group (v0.14): who is in it, what it grants, what its current members
 * used, and its name and deletion. The tab is in the address. An auditor reads
 * every tab; the controls that change anything are left out for them (the API
 * refuses them too).
 */
export function AdminGroupDetailPage() {
  const { groupId } = useParams({ strict: false }) as { groupId: string };
  const navigate = useNavigate();
  const tab = validateGroupSearch(useSearch({ strict: false })).tab ?? DEFAULT_GROUP_TAB;
  const setTab = (next: GroupTab) =>
    void navigate({
      to: '/admin/groups/$groupId',
      params: { groupId },
      search: { tab: next === DEFAULT_GROUP_TAB ? undefined : next },
      replace: true,
    });

  const detail = useQuery({
    queryKey: groupDetailKey(groupId),
    queryFn: () => api.get<AdminGroupDetail>(`/admin/groups/${groupId}`),
  });
  const group = detail.data;
  usePageTitle(group ? pageWithin(group.name, '/admin/groups') : null);

  const back = (
    <Link
      to="/admin/groups"
      className="inline-flex items-center gap-1.5 text-[var(--text-muted)] text-sm hover:text-[var(--text-primary)]"
    >
      <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
      All groups
    </Link>
  );

  if (detail.isLoading) return <FullPageSpinner />;

  if (!group) {
    return (
      <div>
        {back}
        <LoadError title="This group could not be loaded." query={detail} className="mt-6" />
      </div>
    );
  }

  return (
    <div>
      {back}
      <AdminPageHeader title={group.name} description={group.description ?? undefined} />

      <div className="-mt-4 mb-6 flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral">{plural(group.memberCount, 'member')}</Badge>
        <Badge variant="neutral">{plural(group.managerCount, 'manager')}</Badge>
        <Badge variant="outline">{plural(group.policyCount, 'budget')}</Badge>
        <Badge variant="outline">{plural(group.modelCount, 'model')}</Badge>
      </div>

      <div className="flex flex-col gap-8 pb-10">
        <PillTabs
          tabs={TABS}
          active={tab}
          onChange={setTab}
          label="Group sections"
          controls="group-panel"
        />

        <div id="group-panel" role="tabpanel" aria-label={TAB_LABELS[tab]}>
          {tab === 'members' && <MembersPanel group={group} />}
          {tab === 'grants' && <GrantsPanel group={group} />}
          {tab === 'usage' && <UsagePanel group={group} />}
          {tab === 'settings' && <SettingsPanel group={group} refetch={() => detail.refetch()} />}
        </div>
      </div>
    </div>
  );
}
