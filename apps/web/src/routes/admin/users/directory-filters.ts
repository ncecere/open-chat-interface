/** Matches the API's own default; the server caps it at 200. */
export const PAGE_SIZE = 50;

export type SortKey = 'created' | 'name' | 'email' | 'role' | 'lastSeen' | 'threads' | 'messages';

export interface UserDirectoryFilters {
  search: string;
  role: string;
  status: string;
  sort: SortKey;
  direction: 'asc' | 'desc';
}

export function userListParams(filters: UserDirectoryFilters, page: number) {
  const { search, role, status, sort, direction } = filters;
  const params = new URLSearchParams({
    sort,
    direction,
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (search) params.set('search', search);
  if (role !== 'all') params.set('role', role);
  if (status !== 'all') params.set('status', status);
  return params;
}

export function savedUserFilters({ search, role, status, sort, direction }: UserDirectoryFilters) {
  // Save filters, never the page: page four means nothing tomorrow.
  return {
    ...(search.trim() && { search: search.trim() }),
    ...(role !== 'all' && { role }),
    ...(status !== 'all' && { status }),
    sort,
    direction,
  };
}

export function applySavedUserFilters(
  current: UserDirectoryFilters,
  saved: Record<string, string>,
): UserDirectoryFilters {
  return {
    search: saved.search ?? '',
    role: saved.role ?? 'all',
    status: saved.status ?? 'all',
    sort: saved.sort ? (saved.sort as SortKey) : current.sort,
    direction: saved.direction ? (saved.direction as 'asc' | 'desc') : current.direction,
  };
}
