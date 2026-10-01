import type { AdminUser } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useAdminAccess } from '~/components/admin/admin-access';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import type { SortKey } from './directory-filters';
import type { useUserSelection } from './use-user-selection';

const ROLE_VARIANT = {
  admin: 'accent',
  auditor: 'accent',
  user: 'neutral',
  restricted: 'outline',
} as const;

/** One mutation shared by all rows, including its pending state. */
export function useUserRoleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUser['role'] }) =>
      api.patch(`/admin/users/${id}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

/** aria-sort exposes the active order independently of the arrow icon. */
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

export function UserTable({
  users,
  sort,
  direction,
  onSort,
  selection,
  updateRole,
  onLimits,
}: {
  users: AdminUser[];
  sort: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  selection: Pick<
    ReturnType<typeof useUserSelection>,
    'selected' | 'toggleSelected' | 'allOnPageSelected' | 'selectPage'
  >;
  updateRole: ReturnType<typeof useUserRoleMutation>;
  onLimits: (user: AdminUser) => void;
}) {
  const { selected, toggleSelected, allOnPageSelected, selectPage } = selection;
  // Selection only feeds bulk changes, so read-only viewers get no checkboxes.
  const { canEdit } = useAdminAccess();
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            {canEdit && (
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select every account on this page"
                  checked={allOnPageSelected}
                  onChange={(event) => selectPage(event.target.checked)}
                />
              </th>
            )}
            <SortableHeader
              label="User"
              sortKey="name"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Role"
              sortKey="role"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Threads"
              sortKey="threads"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Joined"
              sortKey="created"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            {canEdit && (
              <th className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-[var(--border-subtle)] last:border-0">
              {canEdit && (
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${user.email}`}
                    checked={selected.has(user.id)}
                    onChange={() => toggleSelected(user.id)}
                  />
                </td>
              )}
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
              {canEdit && (
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => onLimits(user)}>
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
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
