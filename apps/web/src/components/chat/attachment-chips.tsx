import { AlertCircle, FileText, X } from 'lucide-react';
import type { PendingAttachment } from '~/hooks/use-attachments';
import { cn, formatBytes } from '~/lib/utils';

/** Uploaded and in-flight files shown above the composer textarea. */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {items.map((item) => {
        const isImage = item.mimeType.startsWith('image/');
        const failed = item.status === 'error';

        return (
          <div
            key={item.localId}
            className={cn(
              'group relative flex items-center gap-2 rounded-lg border px-2 py-1.5',
              failed
                ? 'border-[var(--danger)]/50 bg-[var(--danger)]/10'
                : 'border-[var(--border-strong)] bg-[var(--bg-control-alt)]',
            )}
            title={failed ? item.error : `${item.filename} · ${formatBytes(item.sizeBytes)}`}
          >
            {isImage && item.previewUrl ? (
              <img src={item.previewUrl} alt="" className="size-7 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex size-7 shrink-0 items-center justify-center rounded bg-[var(--bg-control-hover)]">
                {failed ? (
                  <AlertCircle className="size-3.5 text-[var(--danger-foreground)]" />
                ) : (
                  <FileText className="size-3.5 text-[var(--text-muted)]" />
                )}
              </span>
            )}

            <span className="max-w-40 truncate text-xs text-[var(--text-secondary)]">
              {item.filename}
            </span>

            {item.status === 'uploading' && (
              <span className="text-[0.625rem] text-[var(--text-muted)]">uploading…</span>
            )}

            <button
              type="button"
              onClick={() => onRemove(item.localId)}
              aria-label={`Remove ${item.filename}`}
              className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
