import { FolderOpen } from 'lucide-react';
import { useId } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { useProjectFiles, useProjectsAvailable } from '~/hooks/use-projects';
import { cn } from '~/lib/utils';

interface ProjectFilesControlProps {
  projectId: string;
  /** Files left out of the next message, by id. */
  excluded: readonly string[];
  onExcludedChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * The composer's "Project files" control (v0.10): in a conversation whose
 * project has searchable (indexed) files, it lists the project's files with a
 * checkbox each, all ticked by default. Unticked files are left out of the
 * next message only; the composer resets them once the message is sent.
 */
export function ProjectFilesControl({
  projectId,
  excluded,
  onExcludedChange,
  disabled = false,
}: ProjectFilesControlProps) {
  const headingId = useId();
  // Without the projects feature the server ignores the project, so there is nothing to choose.
  const available = useProjectsAvailable();
  const { data: files = [] } = useProjectFiles(projectId, available);
  if (!available || !files.some((file) => file.index.status === 'indexed')) return null;
  const left = new Set(excluded.filter((id) => files.some((file) => file.id === id)));
  const label =
    left.size === 0
      ? 'Project files'
      : `Project files: ${files.length - left.size} of ${files.length}`;

  function toggle(id: string, included: boolean) {
    const next = new Set(left);
    if (included) next.delete(id);
    else next.add(id);
    onExcludedChange([...next]);
  }

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          data-testid="project-files-control"
          className={cn(
            'inline-flex h-[1.875rem] items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-40',
            left.size > 0
              ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
              : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <FolderOpen className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">
            {left.size === 0 ? 'Files' : `Files ${files.length - left.size}/${files.length}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-3">
        <p id={headingId} className="text-sm font-medium">
          Project files for the next message
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          Untick a file to leave it out of the next message. The reply says which files were left
          out.
        </p>
        <ul
          aria-labelledby={headingId}
          className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto"
        >
          {files.map((file) => {
            const id = `${headingId}-${file.id}`;
            return (
              <li key={file.id} className="flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 shrink-0 accent-[var(--accent-send)]"
                  checked={!left.has(file.id)}
                  onChange={(event) => toggle(file.id, event.target.checked)}
                />
                <label
                  htmlFor={id}
                  className="min-w-0 flex-1 truncate text-sm"
                  title={file.filename}
                >
                  {file.filename}
                </label>
              </li>
            );
          })}
        </ul>
        {left.size > 0 && (
          <button
            type="button"
            onClick={() => onExcludedChange([])}
            className="mt-2 text-xs text-[var(--text-secondary)] underline-offset-2 hover:underline"
          >
            Use all files
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
