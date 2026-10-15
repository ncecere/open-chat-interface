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
import { formatDate, useT } from '~/lib/i18n';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';

function Members({ group }: { group: ManagedGroup }) {
  const t = useT();
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
          return describeManagerError(failure, t('groups.manage.addFailed'));
        }}
        onAdded={refresh}
      />

      <section aria-labelledby="managed-members-heading" className="flex flex-col gap-3">
        <h2 id="managed-members-heading" className="font-semibold text-xl">
          {t('groups.manage.peopleIn', { name: isolate(group.name) })}
        </h2>
        <div className="relative w-full max-w-sm">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t('groups.manage.searchLabel')}
            placeholder={t('groups.manage.searchPlaceholder')}
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
          <div role="status" aria-label={t('groups.manage.membersLoading')} className="py-10">
            <Spinner className="mx-auto size-5" />
          </div>
        ) : !data ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-[var(--danger)]">
              {apiErrorMessage(members.error, t('groups.manage.membersLoadFailed'))}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void members.refetch()}>
              {t('projects.common.tryAgain')}
            </Button>
          </div>
        ) : data.members.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">
            {search.trim() ? t('groups.manage.noMatches') : t('groups.manage.noMembers')}
          </p>
        ) : (
          <section
            // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
            tabIndex={0}
            aria-label={t('groups.manage.tableLabel')}
            className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
          >
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-[var(--bg-control-alt)] text-[var(--text-muted)] text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('groups.manage.columnName')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('groups.manage.columnEmail')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('groups.manage.columnRole')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('groups.manage.columnAdded')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    <span className="sr-only">{t('groups.manage.columnActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const mine = member.userId === me?.user.id;
                  return (
                    <tr key={member.userId} className="border-[var(--border-subtle)] border-t">
                      <td dir="auto" className="px-4 py-2 font-medium">
                        {member.name}
                      </td>
                      <td dir="auto" className="px-4 py-2 text-[var(--text-secondary)]">
                        {member.email}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={member.role === 'manager' ? 'accent' : 'neutral'}>
                          {member.role === 'manager'
                            ? t('groups.role.manager')
                            : t('groups.role.member')}
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
                            {t('groups.manage.leaveButton', { name: isolate(group.name) })}
                          </Button>
                        ) : member.role === 'member' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('groups.manage.removeMember', {
                              name: isolate(member.name),
                            })}
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
          <nav
            aria-label={t('groups.manage.pagesLabel')}
            className="flex items-center justify-between gap-4"
          >
            <p aria-live="polite" className="text-[var(--text-muted)] text-sm">
              {t('groups.manage.showing', { first, last, total })}
            </p>
            {total > pageSize && (
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  {t('groups.manage.previous')}
                </Button>
                <span className="text-[var(--text-muted)] text-sm">
                  {t('groups.manage.pageOf', { page, pages: pageCount })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page >= pageCount}
                  onClick={() => setPage(page + 1)}
                >
                  {t('groups.manage.next')}
                </Button>
              </span>
            )}
          </nav>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          leaving
            ? t('groups.manage.leaveTitle', { name: isolate(group.name) })
            : removing
              ? t('groups.manage.removeTitle', { person: isolate(removing.name) })
              : t('groups.manage.removeTitleUnnamed')
        }
        description={
          leaving
            ? t('groups.manage.leaveBody', { name: isolate(group.name) })
            : removing
              ? t('groups.manage.removeBody', {
                  person: isolate(removing.name),
                  name: isolate(group.name),
                })
              : t('groups.manage.removeBodyUnnamed', { name: isolate(group.name) })
        }
        confirmLabel={leaving ? t('groups.manage.leaveConfirm') : t('groups.manage.removeConfirm')}
        pendingLabel={leaving ? t('groups.manage.leavePending') : t('groups.manage.removePending')}
        errorMessage={leaving ? t('groups.manage.leaveFailed') : t('groups.manage.removeFailed')}
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
  const t = useT();
  const [chosen, setChosen] = useState<string | null>(null);
  const groups = useQuery({
    queryKey: MANAGED_GROUPS_KEY,
    queryFn: () => api.get<{ groups: ManagedGroup[] }>('/groups/managed'),
  });
  const list = groups.data?.groups ?? [];
  const group = list.find((entry) => entry.id === chosen) ?? list[0];

  return (
    <div>
      <h1 className="text-2xl font-bold">{t('groups.manage.title')}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{t('groups.manage.description')}</p>

      <div className="mt-8">
        {groups.isLoading ? (
          <div className="py-16" role="status" aria-label={t('groups.manage.groupsLoading')}>
            <Spinner className="mx-auto size-6" />
          </div>
        ) : groups.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-[var(--danger)]">
              {t('groups.manage.groupsLoadFailed')}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {apiErrorMessage(groups.error, t('groups.manage.checkConnection'))}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void groups.refetch()}>
              {t('projects.common.tryAgain')}
            </Button>
          </div>
        ) : !group ? (
          <p className="text-sm text-[var(--text-muted)]">{t('groups.manage.noGroups')}</p>
        ) : (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-2">
              {list.length > 1 && (
                <div className="w-full max-w-xs">
                  <Select
                    aria-label={t('groups.manage.groupLabel')}
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
              <p className="text-xs text-[var(--text-muted)]">
                {t('groups.manage.memberCount', {
                  count: group.memberCount,
                  limit: group.memberLimit,
                })}
              </p>
            </div>
            {/* Keyed by group: a search or half-typed list is never carried to another. */}
            <Members key={group.id} group={group} />
          </div>
        )}
      </div>
    </div>
  );
}
