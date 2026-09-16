import type { AuditLogEntry } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

const MAX_METADATA_CHARACTERS = 20_000;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(value: string): string {
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

export function actorLabel(entry: AuditLogEntry): string {
  return entry.actorEmail ?? entry.actorUserId ?? 'System';
}

export function targetLabel(entry: AuditLogEntry): string {
  if (entry.targetType && entry.targetId) return `${entry.targetType}: ${entry.targetId}`;
  return entry.targetType ?? entry.targetId ?? '—';
}

/**
 * The target as a link where the thing has a page of its own.
 *
 * An audit row naming a user identifier that cannot be clicked leaves the
 * reader to copy it into a search box, which is the sort of friction that
 * makes a log go unread.
 */
export function TargetCell({ entry }: { entry: AuditLogEntry }) {
  const label = targetLabel(entry);

  if (entry.targetType === 'user' && entry.targetId) {
    return (
      <Link
        to="/admin/users/$userId"
        params={{ userId: entry.targetId }}
        className="hover:underline"
        title={label}
      >
        {label}
      </Link>
    );
  }

  return <span title={label}>{label}</span>;
}

export function EventDetails({ entry }: { entry: AuditLogEntry }) {
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

export function DetailsButton({
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
