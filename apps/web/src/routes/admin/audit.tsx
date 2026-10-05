import { Download, ScrollText, Search, X } from 'lucide-react';
import { AdminPageHeader, EmptyState } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { apiErrorMessage } from '~/lib/api-client';
import { DesktopEventTable, MobileEventList } from './audit/event-list';
import { PAGE_SIZE, RANGES, useAuditLog } from './audit/use-audit-log';

export function AdminAuditPage() {
  const {
    search,
    setSearch,
    subject,
    clearSubject,
    clearFilters,
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
  } = useAuditLog();
  return (
    <div>
      <AdminPageHeader
        title="Audit log"
        description="Search administrative and security events across the retained history."
      />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_12rem_auto]">
        <div className="relative">
          <label htmlFor="audit-search" className="sr-only">
            Search audit events
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            id="audit-search"
            type="search"
            className="pl-9"
            placeholder="Search actor, action, target, or metadata…"
            value={search}
            onChange={(event) => {
              setPage(0);
              setSearch(event.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor="audit-action" className="sr-only">
            Filter by action
          </label>
          <Select
            id="audit-action"
            value={action}
            aria-label="Filter audit events by action"
            onChange={(value) => {
              setPage(0);
              setAction(value);
            }}
            options={[
              { value: 'all', label: 'All actions' },
              ...actions.map((option) => ({ value: option, label: option })),
            ]}
          />
        </div>
        <div>
          <label htmlFor="audit-range" className="sr-only">
            Filter by date
          </label>
          <Select
            id="audit-range"
            value={range}
            aria-label="Filter audit events by date"
            onChange={(value) => {
              setPage(0);
              setRange(value);
            }}
            options={RANGES.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
        <Button variant="secondary" onClick={exportCsv} disabled={total === 0}>
          <Download />
          Export
        </Button>
      </div>

      {subject && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-control)] py-1 pr-1 pl-3">
            Events by or about{' '}
            <span className="font-medium text-[var(--text-primary)]">
              {subject.email ?? subject.id}
            </span>
            <button
              type="button"
              onClick={clearSubject}
              aria-label={`Stop showing only events by or about ${subject.email ?? subject.id}`}
              className="rounded-full p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
      )}

      {audit.isLoading ? (
        <div
          className="flex min-h-56 items-center justify-center"
          role="status"
          aria-label="Loading audit events"
        >
          <Spinner className="size-6" />
        </div>
      ) : audit.isError || !entries ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Audit events could not be loaded.
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {apiErrorMessage(audit.error, 'Please try again.')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void audit.refetch()}>
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-6">
          <EmptyState icon={ScrollText} title="No audit events yet.">
            Administrative activity will appear here when events are recorded.
          </EmptyState>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            No events match your filters.
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            Try another search or clear the filters.
          </p>
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="mt-6">
          <p className="mb-2 text-xs text-[var(--text-muted)]" aria-live="polite">
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}{' '}
            event{total === 1 ? '' : 's'}
            {hasFilters ? ' matching your filters' : ''}.
          </p>
          <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            <DesktopEventTable
              entries={filteredEntries}
              expandedIds={expandedIds}
              onToggle={toggleDetails}
            />
            <MobileEventList
              entries={filteredEntries}
              expandedIds={expandedIds}
              onToggle={toggleDetails}
            />
          </div>

          {total > PAGE_SIZE && (
            <nav aria-label="Audit log pages" className="mt-4 flex items-center justify-end gap-2">
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
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
