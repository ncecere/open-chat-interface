import type { UIMessage } from 'ai';

/** Use the actual serialized request, not a composer queue that may have changed. */
export function readChatSubmission(body: RequestInit['body'] | undefined) {
  if (typeof body !== 'string') return null;
  try {
    const value = JSON.parse(body) as { attachmentIds?: unknown; messages?: UIMessage[] } | null;
    const user = value?.messages?.[0];
    if (
      user?.role !== 'user' ||
      typeof user.id !== 'string' ||
      !Array.isArray(value?.attachmentIds) ||
      !value.attachmentIds.every((id: unknown) => typeof id === 'string')
    )
      return null;
    return { clientMessageId: user.id, attachmentIds: value.attachmentIds as string[] };
  } catch {
    return null;
  }
}

/**
 * A new message the server refused before saving it (any 4xx: rate limit,
 * quota, too many files, a model the role cannot use). Null for anything else,
 * including a retry or regenerate, whose user message is already saved.
 */
export function readRefusedSubmission(
  body: RequestInit['body'] | undefined,
): { clientMessageId: string; text: string } | null {
  if (typeof body !== 'string') return null;
  try {
    const value = JSON.parse(body) as { trigger?: unknown; messages?: UIMessage[] } | null;
    const user = value?.messages?.[0];
    if (value?.trigger !== 'submit-message' || user?.role !== 'user' || typeof user.id !== 'string')
      return null;
    const text = user.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    return { clientMessageId: user.id, text };
  } catch {
    return null;
  }
}

/** Only persisted user references confirm that an ambiguously sent file was allocated. */
export function confirmedAttachmentIds(messages: UIMessage[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.role === 'user'
          ? message.parts.flatMap((part) =>
              part.type === 'data-attachment' &&
              typeof part.data === 'object' &&
              part.data !== null &&
              'id' in part.data &&
              typeof part.data.id === 'string'
                ? [part.data.id]
                : [],
            )
          : [],
      ),
    ),
  ];
}

/** Keep the optimistic prompt's parts, but use its server ID for retry/edit/branch actions. */
export function confirmPromptId(
  messages: UIMessage[],
  clientId: string,
  storedId: string,
): UIMessage[] {
  if (clientId === storedId) return messages;
  return messages.map((message) =>
    message.role === 'user' && message.id === clientId ? { ...message, id: storedId } : message,
  );
}
