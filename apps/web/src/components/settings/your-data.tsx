import type { ConversationImportSummary, ImportStatus } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button, buttonVariants } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { api, apiErrorMessage } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import {
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  type MessageKey,
  translate,
  useT,
} from '~/lib/i18n';
import { uploadImportFile } from '~/lib/import-upload';
import { useReadOnlyLock } from '~/lib/read-only';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { cn } from '~/lib/utils';

const IMPORTS_KEY = ['me', 'imports'] as const;
/** How often the list refreshes while an import is queued or running. */
export const IMPORT_POLL_MS = 2_000;

const STATUS_LABELS: Record<ImportStatus, MessageKey> = {
  pending: 'settings.imports.statusPending',
  running: 'settings.imports.statusRunning',
  completed: 'settings.imports.statusCompleted',
  failed: 'settings.imports.statusFailed',
};

const STATUS_VARIANTS = {
  pending: 'neutral',
  running: 'soft',
  completed: 'success',
  failed: 'danger',
} as const;

/** The products stay as named; the rest of the label is translated. */
function sourceLabel(record: ConversationImportSummary): string {
  const label =
    record.source === 'chatgpt'
      ? 'ChatGPT'
      : record.source === 'claude'
        ? 'Claude'
        : translate(
            record.status === 'pending' || record.status === 'running'
              ? 'settings.imports.sourceDetecting'
              : 'settings.imports.sourceUnknown',
          );
  return record.formatVersion
    ? translate('settings.imports.sourceVersion', { source: label, version: record.formatVersion })
    : label;
}

function countsLine(record: ConversationImportSummary): string {
  const parts = [translate('settings.imports.countImported', { count: record.importedCount })];
  if (record.skippedCount > 0) {
    parts.push(translate('settings.imports.countSkipped', { count: record.skippedCount }));
  }
  if (record.failedCount > 0) {
    parts.push(translate('settings.imports.countFailed', { count: record.failedCount }));
  }
  return parts.join(' · ');
}

function finishedMessage(record: ConversationImportSummary): string {
  if (record.status === 'failed') {
    // The reason is the server's own text.
    return record.error
      ? translate('settings.imports.failedWithReason', {
          filename: record.filename,
          error: record.error,
        })
      : translate('settings.imports.failed', { filename: record.filename });
  }
  return record.skippedCount > 0
    ? translate('settings.imports.finishedSkipped', {
        filename: record.filename,
        count: record.importedCount,
        skipped: record.skippedCount,
      })
    : translate('settings.imports.finished', {
        filename: record.filename,
        count: record.importedCount,
      });
}

function ImportRow({
  record,
  onDelete,
  deleting,
}: {
  record: ConversationImportSummary;
  onDelete: () => void;
  deleting: boolean;
}) {
  const t = useT();
  const active = record.status === 'pending' || record.status === 'running';
  // Cancelling or removing an import is refused while read-only (#353).
  const lock = useReadOnlyLock();
  return (
    <li className="flex items-start gap-3 border-[var(--border-subtle)] border-b py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p dir="auto" className="truncate text-[var(--text-primary)] text-sm">
            {record.filename}
          </p>
          <Badge variant={STATUS_VARIANTS[record.status]}>{t(STATUS_LABELS[record.status])}</Badge>
        </div>
        <p className="mt-0.5 text-[var(--text-muted)] text-xs">
          {sourceLabel(record)} · {formatFileSize(record.sizeBytes)} ·{' '}
          {formatRelativeTime(record.createdAt)}
          {(record.status !== 'pending' || record.importedCount > 0) && ` · ${countsLine(record)}`}
        </p>
        {record.error && <p className="mt-1 text-[var(--danger)] text-xs">{record.error}</p>}
        {record.warnings.map((warning) => (
          <p key={warning} className="mt-1 text-[var(--text-muted)] text-xs">
            {warning}
          </p>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        locked={lock.title}
        disabled={record.status === 'running' || deleting}
        aria-label={
          active
            ? t('settings.imports.cancelLabel', { filename: record.filename })
            : t('settings.imports.removeLabel', { filename: record.filename })
        }
        onClick={onDelete}
      >
        {active ? t('settings.imports.cancel') : t('settings.imports.remove')}
      </Button>
    </li>
  );
}

/**
 * Imports and their progress. Lives with the buttons rather than the dialog,
 * so polling and announcements carry on after the dialog is closed.
 */
function useImports() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));
  const previous = useRef(new Map<string, ImportStatus>());

  const imports = useQuery({
    queryKey: IMPORTS_KEY,
    queryFn: () => api.get<{ imports: ConversationImportSummary[] }>('/me/imports'),
    select: (data) => data.imports,
    refetchInterval: (query) =>
      query.state.data?.imports.some(
        (record) => record.status === 'pending' || record.status === 'running',
      )
        ? IMPORT_POLL_MS
        : false,
  });

  // Announce transitions, and refresh conversation lists once something lands.
  useEffect(() => {
    if (!imports.data) return;
    let landed = false;
    for (const record of imports.data) {
      const before = previous.current.get(record.id);
      const finished = record.status === 'completed' || record.status === 'failed';
      if (before && before !== record.status) {
        if (finished) {
          setAnnouncement(finishedMessage(record));
          if (record.status === 'completed') landed = true;
        } else if (record.status === 'running') {
          setAnnouncement(translate('settings.imports.importing', { filename: record.filename }));
        }
      }
      previous.current.set(record.id, record.status);
    }
    if (landed) void invalidateConversationLists(queryClient);
  }, [imports.data, queryClient]);

  const upload = useMutation({
    mutationFn: (file: File) => uploadImportFile(file, setProgress),
    onMutate: (file) => {
      setError(null);
      setProgress(0);
      setAnnouncement(translate('settings.imports.uploading', { filename: file.name }));
    },
    onSuccess: (record) => {
      previous.current.set(record.id, record.status);
      setAnnouncement(translate('settings.imports.uploaded', { filename: record.filename }));
      void queryClient.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
    onError: (failure) => {
      setAnnouncement('');
      setError(apiErrorMessage(failure, translate('settings.imports.uploadFailed')));
    },
    onSettled: () => setProgress(null),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/me/imports/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMPORTS_KEY }),
    onError: (failure) =>
      setError(apiErrorMessage(failure, translate('settings.imports.removeFailed'))),
  });

  const records = imports.data ?? [];
  const busy =
    upload.isPending ||
    records.some((record) => record.status === 'pending' || record.status === 'running');

  return { records, upload, remove, progress, announcement, error, busy };
}

type ImportsState = ReturnType<typeof useImports>;

function ImportPanel({
  state,
  inputRef,
}: {
  state: ImportsState;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const inputId = useId();
  const helpId = useId();
  const { records, upload, remove, progress, announcement, error, busy } = state;
  // An upload is refused while read-only, so choosing a file is off, with the
  // reason in sight (a title alone is not shown on a phone) (#353).
  const lock = useReadOnlyLock();

  return (
    <div>
      <label htmlFor={inputId} className="sr-only">
        {t('settings.imports.fileLabel')}
      </label>
      <p id={helpId} className="text-[var(--text-muted)] text-sm">
        {t('settings.imports.help')}
      </p>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        aria-describedby={helpId}
        className="sr-only"
        disabled={busy || lock.locked}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate(file);
          // Clear so choosing the same file again still fires a change.
          event.target.value = '';
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          locked={lock.title}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? t('settings.imports.uploadingShort') : t('settings.imports.choose')}
        </Button>
        {progress !== null && (
          <div className="flex min-w-48 flex-1 items-center gap-2">
            <progress
              className="h-1.5 flex-1 accent-[var(--accent)]"
              max={100}
              value={Math.round(progress * 100)}
              aria-label={t('settings.imports.progress')}
            />
            <span className="text-[var(--text-muted)] text-xs tabular-nums">
              {formatNumber(progress, { style: 'percent' })}
            </span>
          </div>
        )}
        {busy && !upload.isPending && (
          <span className="text-[var(--text-muted)] text-xs">
            {t('settings.imports.oneAtATime')}
          </span>
        )}
      </div>

      {lock.locked && (
        <p className="mt-2 text-[var(--text-muted)] text-xs">
          {t('settings.imports.paused', { reason: lock.title })}
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-2 text-[var(--text-muted)] text-xs">
        {announcement}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[var(--danger)] text-xs">
          {error}
        </p>
      )}

      {records.length > 0 && (
        <ul
          aria-label={t('settings.imports.list')}
          className="mt-3 flex max-h-[40vh] flex-col overflow-y-auto"
        >
          {records.map((record) => (
            <ImportRow
              key={record.id}
              record={record}
              deleting={remove.isPending && remove.variables === record.id}
              onDelete={() => remove.mutate(record.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Settings → History, top of the page: download everything, or bring history
 * in from ChatGPT or Claude, each in a dialog (v0.9.1; before, a section
 * below the conversation list).
 */
export function YourDataButtons() {
  const t = useT();
  const state = useImports();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<'export' | 'import' | null>(null);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={() => setOpen('export')}>
        <Download />
        {t('settings.yourData.export')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setOpen('import')}>
        <Upload />
        {t('settings.yourData.import')}
      </Button>
      {/* While the import dialog is open its own status line speaks instead. */}
      {open !== 'import' && (
        <p role="status" aria-live="polite" className="text-[var(--text-muted)] text-xs">
          {state.announcement}
        </p>
      )}

      <Dialog open={open === 'export'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.yourData.export')}</DialogTitle>
            <DialogDescription>{t('settings.yourData.exportDescription')}</DialogDescription>
          </DialogHeader>
          <a
            href="/api/me/export"
            download
            className={cn(buttonVariants({ variant: 'accent', size: 'sm' }), 'mt-2')}
            onClick={() => setOpen(null)}
          >
            <Download />
            {t('settings.yourData.download')}
          </a>
        </DialogContent>
      </Dialog>

      <Dialog open={open === 'import'} onOpenChange={close}>
        {/* Described by the panel's own help text, tied to the file input. */}
        <DialogContent className="max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('settings.yourData.import')}</DialogTitle>
          </DialogHeader>
          <ImportPanel state={state} inputRef={inputRef} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
