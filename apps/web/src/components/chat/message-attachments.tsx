import type { UIMessage } from 'ai';
import { FileText, FileX } from 'lucide-react';

export interface AttachmentCard {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  /**
   * False when the file can no longer be opened: removed, expired with its
   * conversation, or lost (#359). The server sets it when it sends the
   * conversation; absent means available, as for a file just sent.
   */
  available?: boolean;
}

/** Attachment metadata the server records alongside a sent user turn. */
export function attachmentsOf(message: UIMessage): AttachmentCard[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'data-attachment') return [];
    const data = (part as { data?: Partial<AttachmentCard> }).data;
    return data?.id && data.filename && data.mimeType && data.url ? [data as AttachmentCard] : [];
  });
}

export function MessageAttachments({ message }: { message: UIMessage }) {
  const cards = attachmentsOf(message);
  if (cards.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {cards.map((card) =>
        card.available === false ? (
          <RemovedFile key={card.id} filename={card.filename} />
        ) : card.mimeType.startsWith('image/') ? (
          <a key={card.id} href={card.url} target="_blank" rel="noreferrer" title={card.filename}>
            <img
              src={card.url}
              alt={card.filename}
              className="size-14 rounded-lg border border-[var(--border-strong)] object-cover"
            />
          </a>
        ) : (
          <a
            key={card.id}
            href={card.url}
            target="_blank"
            rel="noreferrer"
            title={card.filename}
            className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control-alt)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-control-hover)]"
          >
            <FileText className="size-4 shrink-0 text-[var(--text-muted)]" />
            <span className="max-w-52 truncate text-sm text-[var(--text-secondary)]">
              {card.filename}
            </span>
          </a>
        ),
      )}
    </div>
  );
}

/**
 * A file that is gone, shown as gone: its name struck through and "No longer
 * available" beside it, not a link that answers 404 (#359). Not a link and not
 * an image, so nothing is requested for it.
 */
function RemovedFile({ filename }: { filename: string }) {
  return (
    <span
      title={`${filename}: no longer available`}
      data-attachment-state="removed"
      className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-control-alt)] px-3 py-2"
    >
      <FileX className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span className="max-w-52 truncate text-sm text-[var(--text-muted)] line-through">
          {filename}
        </span>
        <span className="text-xs text-[var(--text-secondary)]">No longer available</span>
      </span>
    </span>
  );
}
