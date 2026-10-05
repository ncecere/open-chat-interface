import type { ArtifactDetail } from '@oci/shared';
import { cn } from '~/lib/utils';
import { formatDate } from './panel-helpers';

export function VersionList({
  detail,
  selected,
  onSelect,
}: {
  detail: ArtifactDetail | undefined;
  selected: number;
  onSelect: (version: number) => void;
}) {
  if (!detail)
    return (
      <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
        Loading…
      </p>
    );
  return (
    <ol className="divide-y divide-[var(--border-subtle)]" aria-label="Versions, newest first">
      {detail.versions.map((entry) => (
        <li key={entry.version}>
          <button
            type="button"
            onClick={() => onSelect(entry.version)}
            aria-current={entry.version === selected ? 'true' : undefined}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--bg-control)] sm:px-5',
              entry.version === selected && 'bg-[var(--bg-control)]',
            )}
          >
            <span className="font-medium text-[var(--text-primary)]">
              Version {entry.version}
              {entry.version === detail.artifact.currentVersion ? ' (current)' : ''}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {entry.source === 'person' ? 'Edited by you' : 'By the assistant'} ·{' '}
              {formatDate(entry.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
