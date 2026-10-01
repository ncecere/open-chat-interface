import type { AdminUser } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '~/lib/api-client';
import {
  applySavedUserFilters,
  PAGE_SIZE,
  type SortKey,
  type UserDirectoryFilters,
  userListParams,
} from './directory-filters';

interface UsersResponse {
  users: AdminUser[];
  total: number;
}

export function useUserDirectory() {
  const [state, setState] = useState<UserDirectoryFilters & { page: number }>({
    page: 0,
    search: '',
    role: 'all',
    status: 'all',
    sort: 'created',
    direction: 'desc',
  });
  const { page, search, role, status, sort, direction } = state;
  const query = useQuery({
    queryKey: ['admin', 'users', search, role, status, sort, direction, page],
    // Filtering and sorting describe every account, not just the loaded page.
    queryFn: () => api.get<UsersResponse>(`/admin/users?${userListParams(state, page)}`),
    placeholderData: (previous) => previous,
  });
  const { data, isLoading } = query;

  function changeFilter(key: 'search' | 'role' | 'status', value: string) {
    setState((current) => ({ ...current, page: 0, [key]: value }));
  }

  // Re-sorting returns to page one; a new column starts descending.
  function toggleSort(key: SortKey) {
    setState((current) => ({
      ...current,
      page: 0,
      sort: key,
      direction: current.sort === key ? (current.direction === 'asc' ? 'desc' : 'asc') : 'desc',
    }));
  }

  function applyFilters(filters: Record<string, string>) {
    setState((current) => ({ ...applySavedUserFilters(current, filters), page: 0 }));
  }

  const total = data?.total ?? 0;
  return {
    ...state,
    data,
    isLoading,
    query,
    total,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    firstOnPage: total === 0 ? 0 : page * PAGE_SIZE + 1,
    lastOnPage: Math.min(total, (page + 1) * PAGE_SIZE),
    changeFilter,
    toggleSort,
    applyFilters,
    previousPage: () =>
      setState((current) => ({ ...current, page: Math.max(0, current.page - 1) })),
    nextPage: () => setState((current) => ({ ...current, page: current.page + 1 })),
  };
}
