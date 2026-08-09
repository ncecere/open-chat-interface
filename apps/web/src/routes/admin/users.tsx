import { type AdminUser, USER_ROLES } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { QuotaOverrideDialog } from '~/components/admin/quota-override-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';

/** Matches the API's own default; the server caps it at 200. */
const PAGE_SIZE = 50;

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
}

interface UsersResponse {
  users: AdminUser[];
  total: number;
}

const ROLE_VARIANT = {
  admin: 'accent',
  auditor: 'accent',
  user: 'neutral',
  restricted: 'outline',
} as const;

type SortKey = 'created' | 'name' | 'email' | 'role' | 'lastSeen' | 'threads' | 'messages';

const STATUS_OPTIONS = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Not banned' },
  { value: 'banned', label: 'Banned' },
  { value: 'unverified', label: 'Unverified email' },
] as const;

/**
 * A column header that sorts.
 *
 * `aria-sort` is what tells assistive technology which column orders the table
 * and in which direction; without it the arrow is meaningless to anyone not
 * looking at the screen.
 */
function SortableHeader({
  label,
  sortKey,
  active,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const isActive = active === sortKey;

  return (
    <th
      className="px-4 py-3 font-medium"
      aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-[var(--text-primary)]"
      >
        {label}
        {isActive &&
          (direction === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

export function AdminUsersPage() {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkRole, setBulkRole] = useState<AdminUser['role']>('user');
  const [viewName, setViewName] = useState('');

  const views = useQuery({
    queryKey: ['admin', 'views', 'users'],
    queryFn: () => api.get<{ views: SavedView[] }>('/admin/views?surface=users'),
  });

  const saveView = useMutation({
    mutationFn: () =>
      api.post('/admin/views', {
        surface: 'users',
        name: viewName.trim(),
        // Only the filters, not the page: a saved view is a slice of the
        // directory, and page four of it means nothing tomorrow.
        filters: {
          ...(search.trim() && { search: search.trim() }),
          ...(role !== 'all' && { role }),
          ...(status !== 'all' && { status }),
          sort,
          direction,
        },
      }),
    onSuccess: () => {
      setViewName('');
      queryClient.invalidateQueries({ queryKey: ['admin', 'views', 'users'] });
    },
  });

  const deleteView = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/views/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'views', 'users'] }),
  });

  function applyView(view: SavedView) {
    setPage(0);
    setSearch(view.filters.search ?? '');
    setRole(view.filters.role ?? 'all');
    setStatus(view.filters.status ?? 'all');
    if (view.filters.sort) setSort(view.filters.sort as SortKey);
    if (view.filters.direction) setDirection(view.filters.direction as 'asc' | 'desc');
  }
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('created');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [limitsFor, setLimitsFor] = useState<AdminUser | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', search, role, status, sort, direction, page],
    queryFn: () => {
      // Sorting and filtering are applied by the API so they describe every
      // account, not just the page that happens to be loaded.
      const params = new URLSearchParams({
        sort,
        direction,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (search) params.set('search', search);
      if (role !== 'all') params.set('role', role);
      if (status !== 'all') params.set('status', status);
      return api.get<UsersResponse>(`/admin/users?${params}`);
    },
    placeholderData: (previous) => previous,
  });

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstOnPage = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastOnPage = Math.min(total, (page + 1) * PAGE_SIZE);

  /**
   * Clicking the active column flips direction; a new column starts descending.
   *
   * Re-sorting returns to the first page: page four of the old order describes
   * nothing in the new one.
   */
  function toggleSort(key: SortKey) {
    setPage(0);
    if (sort === key) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(key);
    setDirection('desc');
  }

  const bulk = useMutation({
    mutationFn: (body: { action: string; role?: string; reason?: string }) =>
      api.post<{ affected: number; skippedSelf: boolean }>('/admin/users/bulk', {
        userIds: [...selected],
        ...body,
      }),
    onSuccess: () => {
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Offering to save "everything, unsorted" would just add clutter.
  const hasActiveFilters = search.trim() !== '' || role !== 'all' || status !== 'all';
  const pageIds = data?.users.map((user) => user.id) ?? [];
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUser['role'] }) =>
      api.patch(`/admin/users/${id}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <div>
      <AdminPageHeader
        title="Users"
        description={
          data ? `${data.total} account${data.total === 1 ? '' : 's'}` : 'Loading accounts...'
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name or email..."
          className="max-w-sm"
          value={search}
          onChange={(event) => {
            setPage(0);
            setSearch(event.target.value);
          }}
        />
        <Select
          value={role}
          onChange={(value) => {
            setPage(0);
            setRole(value);
          }}
          aria-label="Filter by role"
          className="w-40"
          options={[
            { value: 'all', label: 'Any role' },
            ...USER_ROLES.map((option) => ({
              value: option,
              label: option.charAt(0).toUpperCase() + option.slice(1),
            })),
          ]}
        />
        <Select
          value={status}
          onChange={(value) => {
            setPage(0);
            setStatus(value);
          }}
          aria-label="Filter by status"
          className="w-44"
          options={[...STATUS_OPTIONS]}
        />
      </div>

      {isLoading || !data ? (
        <div className="py-16">
          <FullPageSpinner />
        </div>
      ) : (
        <div className="mt-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {views.data?.views.map((view) => (
              <span
                key={view.id}
                className="flex items-center gap-1 rounded-full bg-[var(--bg-control-alt)] pr-1 pl-3 text-sm"
              >
                <button
                  type="button"
                  className="py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={() => applyView(view)}
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete the ${view.name} view`}
                  className="rounded p-1 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
                  onClick={() => deleteView.mutate(view.id)}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}

            {hasActiveFilters && (
              <span className="flex items-center gap-2">
                <Input
                  aria-label="Name for this view"
                  className="h-8 w-44"
                  placeholder="Save these filters as…"
                  value={viewName}
                  onChange={(event) => setViewName(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!viewName.trim() || saveView.isPending}
                  onClick={() => saveView.mutate()}
                >
                  Save view
                </Button>
              </span>
            )}
          </div>

          {selected.size > 0 && (
            <section
              aria-label="Bulk actions"
              className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3"
            >
              <span className="font-medium text-sm">
                {selected.size} account{selected.size === 1 ? '' : 's'} selected
              </span>

              <span className="ml-auto flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Role to apply"
                  value={bulkRole}
                  onChange={(value) => setBulkRole(value as AdminUser['role'])}
                  options={USER_ROLES.map((role) => ({
                    value: role,
                    label: role.charAt(0).toUpperCase() + role.slice(1),
                  }))}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ action: 'set_role', role: bulkRole })}
                >
                  Apply role
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ action: 'revoke_sessions' })}
                >
                  Sign out
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={bulk.isPending}
                  onClick={() => bulk.mutate({ action: 'ban' })}
                >
                  Ban
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </span>
            </section>
          )}

          {bulk.data?.skippedSelf && (
            <p className="mb-3 text-[var(--text-muted)] text-xs">
              Your own account was left unchanged.
            </p>
          )}

          <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select every account on this page"
                      checked={allOnPageSelected}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const id of pageIds) {
                            if (event.target.checked) next.add(id);
                            else next.delete(id);
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <SortableHeader
                    label="User"
                    sortKey="name"
                    active={sort}
                    direction={direction}
                    onSort={toggleSort}
                  />
                  <SortableHeader
                    label="Role"
                    sortKey="role"
                    active={sort}
                    direction={direction}
                    onSort={toggleSort}
                  />
                  <SortableHeader
                    label="Threads"
                    sortKey="threads"
                    active={sort}
                    direction={direction}
                    onSort={toggleSort}
                  />
                  <SortableHeader
                    label="Joined"
                    sortKey="created"
                    active={sort}
                    direction={direction}
                    onSort={toggleSort}
                  />
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-[var(--border-subtle)] last:border-0"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${user.email}`}
                        checked={selected.has(user.id)}
                        onChange={() => toggleSelected(user.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to="/admin/users/$userId"
                        params={{ userId: user.id }}
                        className="font-medium text-[var(--text-primary)] hover:underline"
                      >
                        {user.name}
                      </Link>
                      <p className="text-xs text-[var(--text-muted)]">{user.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={ROLE_VARIANT[user.role]} className="capitalize">
                        {user.role}
                      </Badge>
                      {user.banned && (
                        <Badge variant="danger" className="ml-1">
                          banned
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{user.threadCount}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {formatRelativeTime(user.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setLimitsFor(user)}>
                        Limits
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={updateRole.isPending}
                        onClick={() =>
                          updateRole.mutate({
                            id: user.id,
                            role: user.role === 'admin' ? 'user' : 'admin',
                          })
                        }
                      >
                        {user.role === 'admin' ? 'Demote' : 'Make admin'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <nav aria-label="User list pages" className="mt-4 flex items-center justify-between gap-4">
          <p aria-live="polite" className="text-[var(--text-muted)] text-sm">
            Showing {firstOnPage}–{lastOnPage} of {total}
          </p>

          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Previous
            </Button>
            <span className="text-[var(--text-muted)] text-sm">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </span>
        </nav>
      )}

      <Dialog open={Boolean(limitsFor)} onOpenChange={(open) => !open && setLimitsFor(null)}>
        {limitsFor && <QuotaOverrideDialog user={limitsFor} onClose={() => setLimitsFor(null)} />}
      </Dialog>
    </div>
  );
}
