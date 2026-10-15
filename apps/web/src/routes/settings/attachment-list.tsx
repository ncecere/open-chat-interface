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
import { tWithNodes } from '~/components/settings/user-text';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { formatDate, formatFileSize, translate, useT } from '~/lib/i18n';
import { toDate } from '~/lib/i18n/format';
import { useReadOnlyLock } from '~/lib/read-only';
import { cn } from '~/lib/utils';

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
  const t = useT();
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
          <span className="absolute bottom-0.5 text-[0.4rem] font-bold leading-none">
            {t('settings.attachments.pdfBadge')}
          </span>
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
  return toDate(value)
    ? formatDate(value, 'medium')
    : translate('settings.attachments.unknownDate');
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
  /** Under "No attachments yet": where uploads come from, for what this role can upload (default: both). */
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
  emptyHint,
}: AttachmentListProps) {
  const t = useT();
  // Deleting a file is refused while read-only (#353).
  const lock = useReadOnlyLock();
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
            {totalCount === 0 ? t('settings.attachments.none') : t('settings.attachments.noMatch')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {totalCount === 0
              ? (emptyHint ?? t('settings.attachments.hintBoth'))
              : t('settings.attachments.noMatchHint')}
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
              ? t('settings.attachments.deselectAllVisible')
              : t('settings.attachments.selectAllVisible')
          }
          onChange={onToggleAll}
        />
        <span>{t('settings.attachments.columnName')}</span>
        <button
          type="button"
          className="hidden items-center justify-end gap-1 text-end transition-colors hover:text-[var(--text-primary)] sm:flex"
          aria-label={t(
            sortDirection === 'asc'
              ? 'settings.attachments.sortNewest'
              : 'settings.attachments.sortOldest',
          )}
          onClick={onSort}
        >
          {t('settings.attachments.columnCreated')}
          {sortDirection === 'asc' ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
        </button>
        <span className="sr-only">{t('settings.attachments.actions')}</span>
      </div>

      {isLoading ? (
        <div
          className="flex min-h-32 items-center justify-center"
          role="status"
          aria-label={t('settings.attachments.loading')}
        >
          <Spinner className="size-6" />
        </div>
      ) : isError ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 px-6 text-center">
          {/* Announced, as every list's load error is (#245). */}
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {t('settings.attachments.loadError')}
          </p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('settings.attachments.retry')}
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
                    label={t('settings.attachments.selectLabel', { name: attachment.filename })}
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
                      <span dir="auto" className="min-w-0 wrap-anywhere">
                        {attachment.filename}
                      </span>
                      <ExternalLink className="mt-1 size-3 shrink-0 text-[var(--text-secondary)] rtl:-scale-x-100" />
                    </a>
                    {/* Wraps: cut short on a phone, it hid the size and date,
                        with no tooltip to read them (#195). */}
                    <p className="text-xs leading-4 wrap-anywhere text-[var(--text-muted)]">
                      {project && (
                        <>
                          {tWithNodes(
                            t,
                            'settings.attachments.project',
                            {},
                            {
                              project: (
                                <Link
                                  to="/projects/$projectId"
                                  params={{ projectId: project.id }}
                                  search={{ tab: 'files' }}
                                  dir="auto"
                                  className="font-medium text-[var(--text-secondary)] hover:underline"
                                >
                                  {project.name}
                                </Link>
                              ),
                            },
                          )}{' '}
                          ·{' '}
                        </>
                      )}
                      {/* A fork's or an edit's copy of a file is listed with its
                          own conversation (#358). */}
                      {attachment.conversation && (
                        <>
                          {tWithNodes(
                            t,
                            'settings.attachments.inConversation',
                            {},
                            {
                              conversation: (
                                <Link
                                  to="/chat/$threadId"
                                  params={{ threadId: attachment.conversation.id }}
                                  dir="auto"
                                  className="font-medium text-[var(--text-secondary)] hover:underline"
                                >
                                  {attachment.conversation.title}
                                </Link>
                              ),
                            },
                          )}{' '}
                          ·{' '}
                        </>
                      )}
                      {/* In a composer and not sent (yet), unlike the rest (#297). */}
                      {attachment.unsent && `${t('settings.attachments.notSent')} · `}
                      {attachment.mimeType} · {formatFileSize(attachment.sizeBytes)}
                      <span className="sm:hidden"> · {formatCreatedAt(attachment.createdAt)}</span>
                    </p>
                  </div>
                </div>

                <time
                  dateTime={attachment.createdAt}
                  className="hidden text-end text-xs text-[var(--text-secondary)] sm:block"
                >
                  {formatCreatedAt(attachment.createdAt)}
                </time>

                {project ? (
                  <Button variant="ghost" size="icon-sm" asChild>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                      search={{ tab: 'files' }}
                      aria-label={t('settings.attachments.manageLabel', {
                        file: attachment.filename,
                        project: project.name,
                      })}
                      title={t('settings.attachments.manageTitle', { project: project.name })}
                    >
                      <FolderOpen />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={isDeleting}
                    aria-label={t('settings.attachments.deleteLabel', {
                      name: attachment.filename,
                    })}
                    title={t('settings.attachments.deleteLabel', { name: attachment.filename })}
                    locked={lock.title}
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
