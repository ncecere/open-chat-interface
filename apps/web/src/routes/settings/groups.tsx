import type { GroupMember, GroupMembersPage, ManagedGroup } from '@oci/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { AddPeopleForm } from '~/components/groups/add-people-form';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api, apiErrorMessage } from '~/lib/api-client';
import { describeManagerError, MANAGED_GROUPS_KEY } from '~/lib/groups';
import { useReadOnlyLock } from '~/lib/read-only';
import { formatDate, plural } from '~/lib/utils';

const memberCountText = (group: ManagedGroup) =>
  `${group.memberCount.toLocaleString('en-US')} of ${group.memberLimit.toLocaleString('en-US')} members`;

function Members({ group }: { group: ManagedGroup }) {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const lock = useReadOnlyLock();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<GroupMember | null>(null);

  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  params.set('page', String(page));
  const members = useQuery({
    queryKey: [...MANAGED_GROUPS_KEY, group.id, 'members', search.trim(), page],
    queryFn: () => api.get<GroupMembersPage>(`/groups/managed/${group.id}/members?${params}`),
    placeholderData: (previous) => previous,
  });
  const data = members.data;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const leaving = removing?.userId === me?.user.id;

  // The groups and the Settings tab both follow who the person manages.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: MANAGED_GROUPS_KEY }),
      queryClient.invalidateQueries({ queryKey: ['me'], exact: true }),
    ]);

  return (
    <div className="flex flex-col gap-8">
      <AddPeopleForm
        path={`/groups/managed/${group.id}/members`}
        withRole={false}
        describeError={(failure) => {
          // A refusal says the person's groups changed under them: read them again.
          void refresh();
          return describeManagerError(failure, 'The people could not be added.');
        }}
        onAdded={refresh}
      />

      <section aria-labelledby="managed-members-heading" className="flex flex-col gap-3">
        <h2 id="managed-members-heading" className="font-semibold text-xl">
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
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-[var(--danger)]">
              {apiErrorMessage(members.error, 'The members could not be loaded.')}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void members.refetch()}>
              Try again
            </Button>
          </div>
        ) : data.members.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">
            {search.trim() ? 'No members match this search.' : 'Nobody is in this group yet.'}
          </p>
        ) : (
          <section
            // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
            tabIndex={0}
            aria-label="Members of this group"
            className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
          >
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-[var(--bg-control-alt)] text-[var(--text-muted)] text-xs">
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
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const mine = member.userId === me?.user.id;
                  return (
                    <tr key={member.userId} className="border-[var(--border-subtle)] border-t">
                      <td className="px-4 py-2 font-medium">{member.name}</td>
                      <td className="px-4 py-2 text-[var(--text-secondary)]">{member.email}</td>
                      <td className="px-4 py-2">
                        <Badge variant={member.role === 'manager' ? 'accent' : 'neutral'}>
                          {member.role === 'manager' ? 'Manager' : 'Member'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-[var(--text-muted)]">
                        {formatDate(member.addedAt)}
                      </td>
                      <td className="px-4 py-2 text-end">
                        {/* A member, or oneself; an administrator removes managers. */}
                        {mine ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            locked={lock.title}
                            onClick={() => setRemoving(member)}
                          >
                            Leave {group.name}
                          </Button>
                        ) : member.role === 'member' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${member.name}`}
                            locked={lock.title}
                            onClick={() => setRemoving(member)}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
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

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={leaving ? `Leave ${group.name}?` : `Remove ${removing?.name ?? 'this person'}?`}
        description={
          leaving
            ? `You will no longer manage ${group.name} or see its members, and you lose what the group gives you. An administrator can add you back.`
            : `${removing?.name ?? 'They'} stays an account holder, and no longer has what ${group.name} gives. The change applies from their next request.`
        }
        confirmLabel={leaving ? 'Leave group' : 'Remove from group'}
        pendingLabel={leaving ? 'Leaving…' : 'Removing…'}
        errorMessage={
          leaving ? 'You could not leave the group.' : 'The person could not be removed.'
        }
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`/groups/managed/${group.id}/members/${removing.userId}`);
          await refresh();
        }}
      />
    </div>
  );
}

/**
 * Settings → Groups (v0.14): for a person who manages groups, the people in
 * them, adding by email and removing. Nothing else: no budgets, models or
 * usage (an administrator's). The tab is shown only while `/api/me` says the
 * person manages a group; opened by address with none, this says so and shows
 * nothing about any group.
 */
export function SettingsGroupsPage() {
  const [chosen, setChosen] = useState<string | null>(null);
  const groups = useQuery({
    queryKey: MANAGED_GROUPS_KEY,
    queryFn: () => api.get<{ groups: ManagedGroup[] }>('/groups/managed'),
  });
  const list = groups.data?.groups ?? [];
  const group = list.find((entry) => entry.id === chosen) ?? list[0];

  return (
    <div>
      <h1 className="text-2xl font-bold">Groups</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        The people in the groups you manage. Add people by their email address, or remove them. An
        administrator sets up the group itself and appoints its managers.
      </p>

      <div className="mt-8">
        {groups.isLoading ? (
          <div className="py-16" role="status" aria-label="Loading your groups">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : groups.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-[var(--danger)]">
              Your groups could not be loaded.
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {apiErrorMessage(groups.error, 'Check your connection and try again.')}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void groups.refetch()}>
              Try again
            </Button>
          </div>
        ) : !group ? (
          <p className="text-sm text-[var(--text-muted)]">You do not manage any groups.</p>
        ) : (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-2">
              {list.length > 1 && (
                <div className="w-full max-w-xs">
                  <Select
                    aria-label="Group"
                    value={group.id}
                    onChange={setChosen}
                    options={list.map((entry) => ({ value: entry.id, label: entry.name }))}
                  />
                </div>
              )}
              <h2 className="font-semibold text-xl">{group.name}</h2>
              {group.description && (
                <p className="text-sm text-[var(--text-secondary)]">{group.description}</p>
              )}
              <p className="text-xs text-[var(--text-muted)]">{memberCountText(group)}</p>
            </div>
            {/* Keyed by group: a search or half-typed list is never carried to another. */}
            <Members key={group.id} group={group} />
          </div>
        )}
      </div>
    </div>
  );
}
