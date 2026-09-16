import type { UIMessage } from 'ai';
import { validationFailed } from '../../lib/errors.js';

export function textParts(parts: unknown): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(parts)) return [];

  return parts.flatMap((part) =>
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
      ? [{ type: 'text' as const, text: (part as { text: string }).text }]
      : [],
  );
}

export function textFromParts(parts: unknown): string {
  return textParts(parts)
    .map((part) => part.text)
    .join('\n');
}

type StoredTurn = { id: string; role: string; parts: unknown };

/** Select immutable server history through a validated regeneration target. */
export function regenerationContext<T extends StoredTurn>(
  storedMessages: T[],
  latest: UIMessage,
  attachmentIds: string[],
) {
  if (attachmentIds.length > 0) {
    throw validationFailed('Attachments cannot be added while regenerating a response');
  }

  const targetIndex = storedMessages.findIndex((message) => message.id === latest.id);
  const target = storedMessages[targetIndex];
  if (target?.role !== 'user') {
    throw validationFailed('The regeneration target must be a user message in this thread');
  }
  if (textFromParts(target.parts) !== textFromParts(latest.parts)) {
    throw validationFailed('The stored user message cannot be changed during regeneration');
  }

  // Later turns remain stored and are never rewritten or deleted.
  return {
    contextMessages: storedMessages.slice(0, targetIndex + 1),
    promptMessageId: target.id,
    latest: { id: target.id, role: 'user', parts: textParts(target.parts) } satisfies UIMessage,
  };
}
