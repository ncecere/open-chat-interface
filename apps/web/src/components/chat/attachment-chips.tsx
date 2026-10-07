import { AlertCircle, FileText, X } from 'lucide-react';
import { useState } from 'react';
import type { PendingAttachment } from '~/hooks/use-attachments';
import { cn, formatBytes } from '~/lib/utils';

/**
 * Why a file was refused, naming it once (#180): the API's reasons and the
 * size check already start with the file's name, so it is not put in front
 * of them again ("walk2-big.txt: walk2-big.txt is larger…").
 */
export function failureText(item: Pick<PendingAttachment, 'filename' | 'error'>): string {
  const reason = item.error ?? 'This file could not be attached.';
  return reason.startsWith(item.filename) ? reason : `${item.filename}: ${reason}`;
}

/** Uploaded and in-flight files shown above the composer textarea. */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  // Previews the browser could not draw: a file named .png that is not an
  // image shows as a document while it uploads, not as a broken image (#209).
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(new Set());
  if (items.length === 0) return null;
  const failures = items.filter((item) => item.status === 'error');

  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-2">
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
              aria-describedby={failed ? `attachment-error-${item.localId}` : undefined}
            >
              {/* A refused "image" may not be one (a renamed archive): no preview. */}
              {isImage && item.previewUrl && !failed && !unreadable.has(item.previewUrl) ? (
                <img
                  src={item.previewUrl}
                  alt=""
                  className="size-7 shrink-0 rounded object-cover"
                  onError={() => {
                    const url = item.previewUrl!;
                    setUnreadable((current) => new Set(current).add(url));
                  }}
                />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center rounded bg-[var(--bg-control-hover)]">
                  {failed ? (
                    <AlertCircle className="size-3.5 text-[var(--danger)]" aria-hidden="true" />
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
      {/* The reason, in words: a tooltip reaches neither keyboard, touch nor
        screen-reader users. Announced as each failure appears. */}
      {failures.length > 0 && (
        <ul role="alert" className="mt-2 flex flex-col gap-1 text-[var(--danger)] text-xs">
          {failures.map((item) => (
            <li key={item.localId} id={`attachment-error-${item.localId}`}>
              {failureText(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
