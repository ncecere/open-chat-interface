import type { AuditLogEntry } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '~/lib/api-client';

interface AuditResponse {
  entries: AuditLogEntry[];
  /** Rows matching the filters, not the number on this page. */
  total: number;
}

/** Windows offered for narrowing the history, rather than a free date picker. */
export const RANGES = [
  { value: 'all', label: 'All time', days: null },
  { value: '24h', label: 'Last 24 hours', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
] as const;

export const PAGE_SIZE = 50;

export function useAuditLog() {
  /**
   * Seeded from the query string so a link can arrive pre-filtered.
   *
   * Read once on mount rather than kept in sync: this is a starting point for
   * somebody who followed a link, and thereafter the controls own the state.
   */
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get('search') ?? '',
  );
  const [action, setAction] = useState('all');
  const [range, setRange] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  /**
   * Filters are sent to the API rather than applied to the loaded page, so a
   * search describes the whole history instead of the rows already fetched.
   */
  const queryParams = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (search.trim()) params.set('search', search.trim());
    if (action !== 'all') params.set('action', action);

    const days = RANGES.find((option) => option.value === range)?.days;
    if (days) params.set('from', new Date(Date.now() - days * 86_400_000).toISOString());

    return params;
  }, [search, action, range, page]);

  const audit = useQuery({
    queryKey: ['admin', 'audit', queryParams.toString()],
    queryFn: () => api.get<AuditResponse>(`/admin/audit?${queryParams}`),
    placeholderData: (previous) => previous,
  });

  // Offered from what the log actually holds, not from the current page.
  const actionList = useQuery({
    queryKey: ['admin', 'audit', 'actions'],
    queryFn: () => api.get<{ actions: string[] }>('/admin/audit/actions'),
  });

  const entries = audit.data?.entries;
  const total = audit.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const actions = actionList.data?.actions ?? [];
  const filteredEntries = entries ?? [];

  function exportCsv() {
    const params = new URLSearchParams(queryParams);
    params.delete('limit');
    params.delete('offset');
    // A normal navigation, so the browser handles the download and the session
    // cookie travels with it.
    window.location.href = `/api/admin/audit/export?${params}`;
  }

  function toggleDetails(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilters = search.trim() !== '' || action !== 'all' || range !== 'all';

  return {
    search,
    setSearch,
    action,
    setAction,
    range,
    setRange,
    page,
    setPage,
    expandedIds,
    audit,
    entries,
    total,
    pageCount,
    actions,
    filteredEntries,
    exportCsv,
    toggleDetails,
    hasFilters,
  };
}
