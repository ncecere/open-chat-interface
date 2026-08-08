import type { AuditLogEntry } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ScrollText, Search } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { AdminPageHeader, EmptyState } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

interface AuditResponse {
  entries: AuditLogEntry[];
}

const MAX_METADATA_CHARACTERS = 20_000;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function serializeMetadata(metadata: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(metadata, null, 2) ?? '{}';
    if (serialized.length <= MAX_METADATA_CHARACTERS) return serialized;
    return `${serialized.slice(0, MAX_METADATA_CHARACTERS)}\n… Metadata truncated for display.`;
  } catch {
    return 'Metadata could not be displayed.';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Please try again.';
}

function actorLabel(entry: AuditLogEntry): string {
  return entry.actorEmail ?? entry.actorUserId ?? 'System';
}

function targetLabel(entry: AuditLogEntry): string {
  if (entry.targetType && entry.targetId) return `${entry.targetType}: ${entry.targetId}`;
  return entry.targetType ?? entry.targetId ?? '—';
}

function eventSearchText(entry: AuditLogEntry): string {
  return [
    entry.action,
    entry.actorEmail,
    entry.actorUserId,
    entry.targetType,
    entry.targetId,
    entry.ipAddress,
    entry.metadata ? serializeMetadata(entry.metadata) : null,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function EventDetails({ entry }: { entry: AuditLogEntry }) {
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--text-secondary)]">Metadata</p>
        {entry.metadata ? (
          <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[var(--text-secondary)]">
            {serializeMetadata(entry.metadata)}
          </pre>
        ) : (
          <p className="mt-1 text-xs text-[var(--text-muted)]">No metadata recorded.</p>
        )}
      </div>
      {entry.ipAddress && (
        <div className="sm:min-w-36">
          <p className="text-xs font-medium text-[var(--text-secondary)]">IP address</p>
          <p className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">
            {entry.ipAddress}
          </p>
        </div>
      )}
    </div>
  );
}

function DetailsButton({
  entry,
  expanded,
  onToggle,
  detailsId,
}: {
  entry: AuditLogEntry;
  expanded: boolean;
  onToggle: () => void;
  detailsId: string;
}) {
  const hasDetails = entry.metadata !== null || entry.ipAddress !== null;

  if (!hasDetails) return <span className="text-xs text-[var(--text-muted)]">No details</span>;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="px-2"
      aria-expanded={expanded}
      aria-controls={detailsId}
      onClick={onToggle}
    >
      Details
      <ChevronDown
        className={cn('transition-transform', expanded && 'rotate-180')}
        aria-hidden="true"
      />
    </Button>
  );
}

function DesktopEventTable({
  entries,
  expandedIds,
  onToggle,
}: {
  entries: AuditLogEntry[];
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[48rem] table-fixed text-left text-sm">
        <caption className="sr-only">Administrative and security audit events</caption>
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <th scope="col" className="w-[19%] px-4 py-3 font-medium">
              Timestamp
            </th>
            <th scope="col" className="w-[22%] px-4 py-3 font-medium">
              Actor
            </th>
            <th scope="col" className="w-[17%] px-4 py-3 font-medium">
              Action
            </th>
            <th scope="col" className="w-[28%] px-4 py-3 font-medium">
              Target
            </th>
            <th scope="col" className="w-[14%] px-4 py-3 text-right font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const expanded = expandedIds.has(entry.id);
            const detailsId = `audit-details-desktop-${entry.id}`;

            return (
              <Fragment key={entry.id}>
                <tr className="border-b border-[var(--border-subtle)]">
                  <td className="px-4 py-3 align-top text-xs text-[var(--text-muted)]">
                    <time dateTime={entry.createdAt} title={entry.createdAt}>
                      {formatTimestamp(entry.createdAt)}
                    </time>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p
                      className="truncate font-medium text-[var(--text-primary)]"
                      title={actorLabel(entry)}
                    >
                      {actorLabel(entry)}
                    </p>
                    {entry.actorEmail && entry.actorUserId && (
                      <p
                        className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]"
                        title={entry.actorUserId}
                      >
                        {entry.actorUserId}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge variant="soft" className="max-w-full font-mono font-medium">
                      <span className="truncate" title={entry.action}>
                        {entry.action}
                      </span>
                    </Badge>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p
                      className="truncate font-mono text-xs text-[var(--text-secondary)]"
                      title={targetLabel(entry)}
                    >
                      {targetLabel(entry)}
                    </p>
                  </td>
                  <td className="px-4 py-2 text-right align-top">
                    <DetailsButton
                      entry={entry}
                      expanded={expanded}
                      detailsId={detailsId}
                      onToggle={() => onToggle(entry.id)}
                    />
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-[var(--border-subtle)]">
                    <td id={detailsId} colSpan={5} className="bg-[var(--bg-control)]/35 px-4 py-4">
                      <EventDetails entry={entry} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileEventList({
  entries,
  expandedIds,
  onToggle,
}: {
  entries: AuditLogEntry[];
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-[var(--border-subtle)] md:hidden">
      {entries.map((entry) => {
        const expanded = expandedIds.has(entry.id);
        const detailsId = `audit-details-mobile-${entry.id}`;

        return (
          <li key={entry.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Badge variant="soft" className="max-w-full font-mono font-medium">
                  <span className="truncate" title={entry.action}>
                    {entry.action}
                  </span>
                </Badge>
                <p className="mt-2 truncate text-sm font-medium" title={actorLabel(entry)}>
                  {actorLabel(entry)}
                </p>
              </div>
              <DetailsButton
                entry={entry}
                expanded={expanded}
                detailsId={detailsId}
                onToggle={() => onToggle(entry.id)}
              />
            </div>

            <dl className="mt-3 grid gap-2 text-xs">
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[var(--text-muted)]">Timestamp</dt>
                <dd className="text-[var(--text-secondary)]">
                  <time dateTime={entry.createdAt} title={entry.createdAt}>
                    {formatTimestamp(entry.createdAt)}
                  </time>
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-[var(--text-muted)]">Target</dt>
                <dd
                  className="truncate font-mono text-[var(--text-secondary)]"
                  title={targetLabel(entry)}
                >
                  {targetLabel(entry)}
                </dd>
              </div>
            </dl>

            {expanded && (
              <div id={detailsId} className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                <EventDetails entry={entry} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AdminAuditPage() {
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const audit = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () => api.get<AuditResponse>('/admin/audit'),
  });

  const entries = audit.data?.entries;
  const actions = useMemo(
    () => [...new Set(entries?.map((entry) => entry.action) ?? [])].sort(),
    [entries],
  );
  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const query = search.trim().toLocaleLowerCase();

    return entries.filter(
      (entry) =>
        (action === 'all' || entry.action === action) &&
        (!query || eventSearchText(entry).includes(query)),
    );
  }, [action, entries, search]);

  function toggleDetails(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilters = search.trim() !== '' || action !== 'all';

  return (
    <div>
      <AdminPageHeader
        title="Audit log"
        description="Review up to 200 of the most recent administrative and security events."
      />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
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
            onChange={(event) => setSearch(event.target.value)}
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
            onChange={setAction}
            options={[
              { value: 'all', label: 'All actions' },
              ...actions.map((option) => ({ value: option, label: option })),
            ]}
          />
        </div>
      </div>

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
          <p className="text-xs text-[var(--text-muted)]">{errorMessage(audit.error)}</p>
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSearch('');
              setAction('all');
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="mt-6">
          <p className="mb-2 text-xs text-[var(--text-muted)]" aria-live="polite">
            Showing {filteredEntries.length} of {entries.length} event
            {entries.length === 1 ? '' : 's'}
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
        </div>
      )}
    </div>
  );
}
