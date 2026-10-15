import type { AdminGroup, AdminGroupsPage as GroupsPage } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Search, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, EmptyState, LoadError, Row, RowList } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { ADMIN_GROUPS_KEY } from '~/lib/groups';
import { formatNumber } from '~/lib/i18n/format';
import { plural } from '~/lib/utils';
import { CreateGroupDialog } from './groups/create-group-dialog';

function GroupRow({ group }: { group: AdminGroup }) {
  return (
    <Row className="items-start gap-3 p-4 sm:px-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
        <UsersRound className="size-4 text-[var(--text-secondary)]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to="/admin/groups/$groupId"
          params={{ groupId: group.id }}
          className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere] font-medium text-[var(--text-primary)] underline-offset-4 hover:underline"
          title={group.name}
        >
          {group.name}
        </Link>
        {group.description && (
          <p
            className="mt-0.5 line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-xs text-[var(--text-muted)]"
            title={group.description}
          >
            {group.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral">{plural(group.memberCount, 'member')}</Badge>
          <Badge variant="neutral">{plural(group.managerCount, 'manager')}</Badge>
          <Badge variant="outline">{plural(group.policyCount, 'budget')}</Badge>
          <Badge variant="outline">{plural(group.modelCount, 'model')}</Badge>
        </div>
      </div>
    </Row>
  );
}

/**
 * Admin → People → Groups (v0.14): the groups, with what each holds. Creating
 * is here; membership, grants and deletion are on a group's own page. An
 * auditor reads everything and changes nothing.
 */
export function AdminGroupsPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  params.set('page', String(page));

  const groups = useQuery({
    queryKey: [...ADMIN_GROUPS_KEY, 'list', search.trim(), page],
    queryFn: () => api.get<GroupsPage>(`/admin/groups?${params}`),
    placeholderData: (previous) => previous,
  });
  const data = groups.data;
  const searching = search.trim() !== '';
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <div>
      <AdminPageHeader
        title="Groups"
        description="A group is a set of people, such as a department, with its own budgets and models. Groups only add: they never take away anything a person’s role allows. People you appoint as managers can add and remove its members."
        actions={
          <EditOnly>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New group
            </Button>
          </EditOnly>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search groups"
            placeholder="Search by name..."
            className="ps-9"
            value={search}
            maxLength={120}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <p aria-live="polite" className="text-xs text-[var(--text-muted)]">
          {data &&
            (searching
              ? `${plural(total, 'group')} match`
              : `${formatNumber(total)} of ${formatNumber(data.limit)} groups`)}
        </p>
      </div>

      <div className="mt-6">
        {groups.isLoading ? (
          <div className="py-16" role="status" aria-label="Loading groups">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : !data ? (
          <LoadError title="Groups could not be loaded." query={groups} />
        ) : data.groups.length > 0 ? (
          <RowList>
            {data.groups.map((group) => (
              <GroupRow key={group.id} group={group} />
            ))}
          </RowList>
        ) : searching ? (
          <EmptyState icon={UsersRound} title="No groups match this search.">
            Try another name, or clear the search to see every group.
          </EmptyState>
        ) : (
          <EmptyState icon={UsersRound} title="No groups yet.">
            Create a group to give a department its own budgets and models, and let a manager keep
            its membership up to date.
          </EmptyState>
        )}
      </div>

      {total > pageSize && (
        <nav aria-label="Group list pages" className="mt-4 flex items-center justify-between gap-4">
          <p aria-live="polite" className="text-[var(--text-muted)] text-sm">
            Showing {first}–{last} of {total}
          </p>
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-[var(--text-muted)] text-sm">
              Page {page} of {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </span>
        </nav>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
      </Dialog>
    </div>
  );
}
