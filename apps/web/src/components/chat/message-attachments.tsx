import type { UIMessage } from 'ai';
import { FileText } from 'lucide-react';

interface AttachmentCard {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
}

/** Attachment metadata the server records alongside a sent user turn. */
function attachmentsOf(message: UIMessage): AttachmentCard[] {
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
        card.mimeType.startsWith('image/') ? (
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
