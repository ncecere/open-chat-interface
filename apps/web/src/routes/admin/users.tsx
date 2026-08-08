import { type AdminUser, USER_ROLES } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
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

interface UsersResponse {
  users: AdminUser[];
  total: number;
}

const ROLE_VARIANT = {
  admin: 'accent',
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
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('created');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [limitsFor, setLimitsFor] = useState<AdminUser | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', search, role, status, sort, direction],
    queryFn: () => {
      // Sorting and filtering are applied by the API so they describe every
      // account, not just the page that happens to be loaded.
      const params = new URLSearchParams({ sort, direction });
      if (search) params.set('search', search);
      if (role !== 'all') params.set('role', role);
      if (status !== 'all') params.set('status', status);
      return api.get<UsersResponse>(`/admin/users?${params}`);
    },
  });

  /** Clicking the active column flips direction; a new column starts descending. */
  function toggleSort(key: SortKey) {
    if (sort === key) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(key);
    setDirection('desc');
  }

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
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          value={role}
          onChange={setRole}
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
          onChange={setStatus}
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
        <div className="mt-6 overflow-hidden rounded-xl border border-[var(--border-subtle)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
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
                <tr key={user.id} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-[var(--text-primary)]">{user.name}</p>
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
      )}

      <Dialog open={Boolean(limitsFor)} onOpenChange={(open) => !open && setLimitsFor(null)}>
        {limitsFor && <QuotaOverrideDialog user={limitsFor} onClose={() => setLimitsFor(null)} />}
      </Dialog>
    </div>
  );
}
