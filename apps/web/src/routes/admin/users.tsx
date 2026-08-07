import type { AdminUser } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
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

export function AdminUsersPage() {
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: () =>
      api.get<UsersResponse>(
        `/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUser['role'] }) =>
      api.patch(`/admin/users/${id}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold">Users</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        {data ? `${data.total} account${data.total === 1 ? '' : 's'}` : 'Loading accounts...'}
      </p>

      <div className="mt-6 max-w-sm">
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {isLoading || !data ? (
        <div className="py-16">
          <FullPageSpinner />
        </div>
      ) : (
        <Card className="mt-6 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Threads</th>
                <th className="px-4 py-3 font-medium">Joined</th>
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
        </Card>
      )}
    </div>
  );
}
