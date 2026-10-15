import { type DataClassificationPartData, dataClassificationPartSchema } from '@oci/shared';
import type { UIMessage } from 'ai';
import { ShieldAlert } from 'lucide-react';
import { warnedText } from '~/lib/classification';

/**
 * Reads the `data-classification` part a reply carries when data
 * classification is set to warn and the message went to a model that is not
 * approved for what the conversation carries (v0.14, #395).
 */
export function dataClassificationOf(message: UIMessage): DataClassificationPartData | null {
  const part = message.parts.find((candidate) => candidate.type === 'data-classification') as
    | { data?: unknown }
    | undefined;
  if (!part) return null;
  const parsed = dataClassificationPartSchema.safeParse(part.data);
  return parsed.success && parsed.data.missing.length > 0 ? parsed.data : null;
}

/**
 * A short note on a reply that went ahead only because the instance is in
 * Warn mode: what `block` would have refused. Drawn like the project search
 * note, so the two read as one family of notes above a reply.
 */
export function DataClassificationNote({ message }: { message: UIMessage }) {
  const warned = dataClassificationOf(message);
  if (!warned) return null;
  return (
    <p
      role="note"
      className="mb-2 flex items-start gap-1.5 text-xs text-[var(--text-muted)]"
      data-data-classification={warned.point}
    >
      <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{warnedText(warned)}</span>
    </p>
  );
}
