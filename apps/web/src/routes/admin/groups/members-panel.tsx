import {
  type AdminGroupDetail,
  GROUP_MEMBER_ROLES,
  type GroupMember,
  type GroupMemberRoleName,
  type GroupMembersPage,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOnly, useAdminAccess } from '~/components/admin/admin-access';
import { EmptyState, LoadError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { AddPeopleForm } from '~/components/groups/add-people-form';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { ADMIN_GROUPS_KEY, describeGroupError, groupDetailKey } from '~/lib/groups';
import { formatDate, plural } from '~/lib/utils';

const ROLE_OPTIONS = GROUP_MEMBER_ROLES.map((role) => ({
  value: role,
  label: role === 'manager' ? 'Manager' : 'Member',
}));

const ROLE_LABEL: Record<GroupMemberRoleName, string> = { member: 'Member', manager: 'Manager' };

function RoleCell({ group, member }: { group: AdminGroupDetail; member: GroupMember }) {
  const queryClient = useQueryClient();
  const { canEdit } = useAdminAccess();
  const change = useMutation({
    mutationFn: (role: GroupMemberRoleName) =>
      api.patch<GroupMember>(`/admin/groups/${group.id}/members/${member.userId}`, { role }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY }),
  });

  if (!canEdit) {
    return (
      <Badge variant={member.role === 'manager' ? 'accent' : 'neutral'}>
        {ROLE_LABEL[member.role]}
      </Badge>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={`Role of ${member.name}`}
        className="w-32"
        value={member.role}
        disabled={change.isPending}
        onChange={(next) => change.mutate(next as GroupMemberRoleName)}
        options={ROLE_OPTIONS}
      />
      {change.error && (
        <p role="alert" className="max-w-56 text-xs text-[var(--danger)]">
          {describeGroupError(change.error, 'The role could not be changed.')}
        </p>
      )}
    </div>
  );
}

function RemoveMember({
  group,
  member,
  onClose,
}: {
  group: AdminGroupDetail;
  member: GroupMember | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ConfirmDialog
      open={member !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Remove ${member?.name ?? 'this person'}?`}
      description={
        <>
          {member?.name ?? 'They'} stays an account holder, and loses the budgets and models{' '}
          {group.name} gives. The change applies from their next request.
        </>
      }
      confirmLabel="Remove from group"
      pendingLabel="Removing…"
      errorMessage="The person could not be removed."
      onConfirm={async () => {
        if (!member) return;
        await api.delete(`/admin/groups/${group.id}/members/${member.userId}`);
        await queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY });
      }}
    />
  );
}

/** The members tab: search, add by email with a role, change a role, remove, pages. */
export function MembersPanel({ group }: { group: AdminGroupDetail }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<GroupMember | null>(null);
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  params.set('page', String(page));

  const members = useQuery({
    queryKey: [...groupDetailKey(group.id), 'members', search.trim(), page],
    queryFn: () => api.get<GroupMembersPage>(`/admin/groups/${group.id}/members?${params}`),
    placeholderData: (previous) => previous,
  });
  const data = members.data;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-col gap-8">
      <EditOnly>
        <AddPeopleForm
          path={`/admin/groups/${group.id}/members`}
          withRole
          describeError={(failure) => describeGroupError(failure, 'The people could not be added.')}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY })}
        />
      </EditOnly>

      <section aria-labelledby="group-members-heading" className="flex flex-col gap-3">
        <h2 id="group-members-heading" className="font-semibold text-base">
          People in {group.name}
        </h2>
        <div className="relative w-full max-w-sm">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search members"
            placeholder="Search by name or email..."
            className="ps-9"
            value={search}
            maxLength={320}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {members.isLoading ? (
          <div role="status" aria-label="Loading members" className="py-10">
            <Spinner className="mx-auto size-5" />
          </div>
        ) : !data ? (
          <LoadError title="Members could not be loaded." query={members} />
        ) : data.members.length === 0 ? (
          <EmptyState
            icon={Search}
            title={search.trim() ? 'No members match this search.' : 'Nobody is in this group yet.'}
          >
            {search.trim() ? undefined : 'Add people by email above.'}
          </EmptyState>
        ) : (
          <section
            // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
            tabIndex={0}
            aria-label="Members of this group"
            className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
          >
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-[var(--bg-control-alt)] text-start text-[var(--text-muted)] text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Added
                  </th>
                  <EditOnly>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </EditOnly>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => (
                  <tr key={member.userId} className="border-[var(--border-subtle)] border-t">
                    <td className="px-4 py-2 font-medium">{member.name}</td>
                    <td className="px-4 py-2 text-[var(--text-secondary)]">{member.email}</td>
                    <td className="px-4 py-2">
                      <RoleCell group={group} member={member} />
                    </td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">
                      {formatDate(member.addedAt)}
                    </td>
                    <EditOnly>
                      <td className="px-4 py-2 text-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${member.name}`}
                          onClick={() => setRemoving(member)}
                        >
                          <Trash2 />
                        </Button>
                      </td>
                    </EditOnly>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {data && data.total > 0 && (
          <nav aria-label="Member list pages" className="flex items-center justify-between gap-4">
            <p aria-live="polite" className="text-[var(--text-muted)] text-sm">
              Showing {first}–{last} of {plural(total, 'member')}
            </p>
            {total > pageSize && (
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
            )}
          </nav>
        )}
      </section>

      <RemoveMember group={group} member={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
