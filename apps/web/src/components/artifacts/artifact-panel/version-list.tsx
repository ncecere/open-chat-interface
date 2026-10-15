import type { ArtifactDetail } from '@oci/shared';
import { useT } from '~/lib/i18n';
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
  const t = useT();
  if (!detail)
    return (
      <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
        {t('artifacts.panel.loading')}
      </p>
    );
  return (
    <ol
      className="divide-y divide-[var(--border-subtle)]"
      aria-label={t('artifacts.versions.label')}
    >
      {detail.versions.map((entry) => (
        <li key={entry.version}>
          <button
            type="button"
            onClick={() => onSelect(entry.version)}
            aria-current={entry.version === selected ? 'true' : undefined}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-4 py-3 text-start text-sm transition-colors hover:bg-[var(--bg-control)] sm:px-5',
              entry.version === selected && 'bg-[var(--bg-control)]',
            )}
          >
            <span className="font-medium text-[var(--text-primary)]">
              {t(
                entry.version === detail.artifact.currentVersion
                  ? 'artifacts.versions.current'
                  : 'artifacts.versions.version',
                { version: entry.version },
              )}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {t(
                entry.source === 'person'
                  ? 'artifacts.versions.byPerson'
                  : 'artifacts.versions.byAssistant',
                { date: formatDate(entry.createdAt) },
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
