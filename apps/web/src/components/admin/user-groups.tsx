import type { UserGroup } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { LoadError } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

export const userGroupsKey = (userId: string) => ['admin', 'users', userId, 'groups'] as const;

/**
 * The groups one person is in, with their role in each (v0.14): what, besides
 * their role, gives them budgets and models. Read-only; a group's people are
 * changed from the group.
 */
export function UserGroupsSection({ userId }: { userId: string }) {
  const headingId = useId();
  const groups = useQuery({
    queryKey: userGroupsKey(userId),
    queryFn: () => api.get<{ groups: UserGroup[] }>(`/admin/users/${userId}/groups`),
  });

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="font-semibold text-base">
          Groups
        </h2>
        <Link to="/admin/groups" className="text-[var(--accent-bright)] text-sm hover:underline">
          All groups
        </Link>
      </div>
      <div className="mt-3">
        {groups.isLoading ? (
          <div role="status" aria-label="Loading groups" className="flex justify-center py-4">
            <Spinner className="size-5" />
          </div>
        ) : !groups.data ? (
          <LoadError title="Groups could not be loaded." query={groups} className="p-6" />
        ) : groups.data.groups.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">Not in any group.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {groups.data.groups.map((group) => (
              <li key={group.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <Link
                  to="/admin/groups/$groupId"
                  params={{ groupId: group.id }}
                  className="min-w-0 truncate text-sm hover:underline"
                  title={group.name}
                >
                  {group.name}
                </Link>
                <Badge variant={group.role === 'manager' ? 'accent' : 'neutral'}>
                  {group.role === 'manager' ? 'Manager' : 'Member'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
