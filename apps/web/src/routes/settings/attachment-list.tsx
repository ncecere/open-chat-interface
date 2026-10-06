import type { StoredFile } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  ImageIcon,
  Paperclip,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { cn, formatBytes } from '~/lib/utils';

interface SelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
  disabled,
}: SelectionCheckboxProps) {
  return (
    <input
      ref={(node) => {
        if (node) node.indeterminate = indeterminate;
      }}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      className="size-4 shrink-0 cursor-pointer accent-[var(--accent-bright)] disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

function AttachmentPreview({ attachment }: { attachment: StoredFile }) {
  const [imageFailed, setImageFailed] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');
  const isPdf = attachment.mimeType === 'application/pdf';

  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-control-hover)] text-[var(--text-secondary)]">
      {isImage && !imageFailed ? (
        <img
          src={attachment.thumbnailUrl ?? attachment.url}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : isPdf ? (
        <span className="relative flex size-full items-center justify-center">
          <FileText className="size-5" />
          <span className="absolute bottom-0.5 text-[0.4rem] font-bold leading-none">PDF</span>
        </span>
      ) : attachment.mimeType.startsWith('text/') || attachment.mimeType === 'application/json' ? (
        <FileText className="size-5" />
      ) : isImage ? (
        <ImageIcon className="size-5" />
      ) : (
        <File className="size-5" />
      )}
    </span>
  );
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

interface AttachmentListProps {
  attachments: StoredFile[];
  totalCount: number;
  selected: Set<string>;
  deletingIds: Set<string>;
  isLoading: boolean;
  isError: boolean;
  sortDirection: 'asc' | 'desc';
  onRetry: () => void;
  onSort: () => void;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onDelete: (ids: string[]) => void;
  /** Under "No attachments yet": where uploads come from, for what this role can upload. */
  emptyHint?: string;
}

export function AttachmentList({
  attachments,
  totalCount,
  selected,
  deletingIds,
  isLoading,
  isError,
  sortDirection,
  onRetry,
  onSort,
  onToggle,
  onToggleAll,
  onDelete,
  emptyHint = 'Files uploaded in chats and to projects will appear here.',
}: AttachmentListProps) {
  // Project files are managed (and deleted) from their project, not here.
  const selectable = attachments.filter((file) => !file.project);
  const selectedVisibleCount = selectable.filter((file) => selected.has(file.id)).length;
  const allVisibleSelected = selectable.length > 0 && selectedVisibleCount === selectable.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  if (!isLoading && !isError && attachments.length === 0) {
    // Compact: a sentence, not an empty table.
    return (
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-4 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-control)]">
          <Paperclip className="size-4 text-[var(--text-muted)]" />
        </span>
        <div>
          <p className="text-sm font-medium text-[var(--text-secondary)]">
            {totalCount === 0 ? 'No attachments yet' : 'No files match this filter'}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {totalCount === 0 ? emptyHint : 'Choose another file type to see your uploads.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-[var(--border-subtle)]">
      <div className="grid h-10 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border-subtle)] px-4 text-xs font-semibold text-[var(--text-secondary)] sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem_2rem]">
        <SelectionCheckbox
          checked={allVisibleSelected}
          indeterminate={someVisibleSelected}
          disabled={selectable.length === 0}
          label={
            allVisibleSelected
              ? 'Deselect all visible attachments'
              : 'Select all visible attachments'
          }
          onChange={onToggleAll}
        />
        <span>Name</span>
        <button
          type="button"
          className="hidden items-center justify-end gap-1 text-right transition-colors hover:text-[var(--text-primary)] sm:flex"
          aria-label={`Sort by date ${sortDirection === 'asc' ? 'newest first' : 'oldest first'}`}
          onClick={onSort}
        >
          Created
          {sortDirection === 'asc' ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
        </button>
        <span className="sr-only">Actions</span>
      </div>

      {isLoading ? (
        <div
          className="flex min-h-32 items-center justify-center"
          role="status"
          aria-label="Loading attachments"
        >
          <Spinner className="size-6" />
        </div>
      ) : isError ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 px-6 text-center">
          {/* Announced, as every list's load error is (#245). */}
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            Attachments could not be loaded.
          </p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div>
          {attachments.map((attachment) => {
            const isSelected = selected.has(attachment.id);
            const isDeleting = deletingIds.has(attachment.id);
            const project = attachment.project;

            return (
              <div
                key={attachment.id}
                // Where focus goes when the file before it is deleted (#128).
                data-focus-row=""
                className={cn(
                  'grid min-h-14 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2 last:border-b-0 sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem_2rem]',
                  isSelected && 'bg-[var(--accent-soft)]/45',
                  isDeleting && 'opacity-55',
                )}
              >
                {project ? (
                  <span aria-hidden="true" />
                ) : (
                  <SelectionCheckbox
                    checked={isSelected}
                    disabled={isDeleting}
                    label={`Select ${attachment.filename}`}
                    onChange={() => onToggle(attachment.id)}
                  />
                )}

                <div className="flex min-w-0 items-center gap-3">
                  <AttachmentPreview attachment={attachment} />
                  <div className="min-w-0">
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      // 24px tall at least: the WCAG 2.2 target size (#105).
                      className="group flex min-h-6 min-w-0 items-start gap-1.5 py-0.5 text-sm font-medium text-[var(--text-primary)] hover:underline"
                    >
                      {/* Wraps, as the details line does (#195): cut short, the
                          name could be read only in a tooltip, which touch
                          cannot reach (#244). The icon stays by the first line. */}
                      <span className="min-w-0 wrap-anywhere">{attachment.filename}</span>
                      <ExternalLink className="mt-1 size-3 shrink-0 text-[var(--text-secondary)]" />
                    </a>
                    {/* Wraps: cut short on a phone, it hid the size and date,
                        with no tooltip to read them (#195). */}
                    <p className="text-xs leading-4 wrap-anywhere text-[var(--text-muted)]">
                      {project && (
                        <>
                          Project{' '}
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: project.id }}
                            search={{ tab: 'files' }}
                            className="font-medium text-[var(--text-secondary)] hover:underline"
                          >
                            {project.name}
                          </Link>{' '}
                          ·{' '}
                        </>
                      )}
                      {/* In a composer and not sent (yet), unlike the rest (#297). */}
                      {attachment.unsent && 'Not sent · '}
                      {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
                      <span className="sm:hidden"> · {formatCreatedAt(attachment.createdAt)}</span>
                    </p>
                  </div>
                </div>

                <time
                  dateTime={attachment.createdAt}
                  className="hidden text-right text-xs text-[var(--text-secondary)] sm:block"
                >
                  {formatCreatedAt(attachment.createdAt)}
                </time>

                {project ? (
                  <Button variant="ghost" size="icon-sm" asChild>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                      search={{ tab: 'files' }}
                      aria-label={`Manage ${attachment.filename} in ${project.name}`}
                      title={`Manage in ${project.name}`}
                    >
                      <FolderOpen />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={isDeleting}
                    aria-label={`Delete ${attachment.filename}`}
                    title={`Delete ${attachment.filename}`}
                    className="border border-[var(--danger)]/45 bg-[var(--danger)]/15 text-[var(--danger-on-tint)] hover:bg-[var(--danger)]/30"
                    onClick={() => onDelete([attachment.id])}
                  >
                    {isDeleting ? <Spinner className="size-3.5" /> : <Trash2 />}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
