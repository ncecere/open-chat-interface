import type { AdminUser } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '~/lib/api-client';

export function selectUserPage(current: Set<string>, pageIds: string[], checked: boolean) {
  const next = new Set(current);
  for (const id of pageIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** What a bulk action did: accounts changed, and sessions a sign-out or ban ended. */
export interface BulkResult {
  affected: number;
  skippedSelf: boolean;
  /** Absent before v0.11.1, and for role changes. */
  sessionsEnded?: number;
}

/** Selection spans pages and filters until explicitly cleared or a bulk action succeeds. */
export function useUserSelection(pageIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkRole, setBulkRole] = useState<AdminUser['role']>('user');
  const queryClient = useQueryClient();
  const bulk = useMutation({
    mutationFn: (body: { action: string; role?: string; reason?: string }) =>
      api.post<BulkResult>('/admin/users/bulk', {
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

  return {
    selected,
    bulkRole,
    setBulkRole,
    bulk,
    toggleSelected,
    allOnPageSelected: pageIds.length > 0 && pageIds.every((id) => selected.has(id)),
    selectPage: (checked: boolean) =>
      setSelected((current) => selectUserPage(current, pageIds, checked)),
    clear: () => setSelected(new Set()),
  };
}
