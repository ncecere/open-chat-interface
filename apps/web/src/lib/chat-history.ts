import type { UIMessage } from 'ai';
import { api } from './api-client';

export interface ChatHistory {
  thread: { id: string; temporary: boolean; expiresAt: string | null };
  /** The conversation as it reads: one active reply per turn. */
  messages: UIMessage[];
  /**
   * Every reply to the latest turn, oldest first, when it was retried; empty
   * otherwise. The active one is also the last entry of `messages`.
   */
  replies: UIMessage[];
}

const invalidMessages = (messages: unknown) =>
  !Array.isArray(messages) ||
  messages.some(
    (message: UIMessage) =>
      !message ||
      typeof message.id !== 'string' ||
      !['user', 'assistant', 'system'].includes(message.role) ||
      !Array.isArray(message.parts) ||
      message.parts.some((part) => !part || typeof part.type !== 'string'),
  );

export async function getChatHistory(threadId: string, signal?: AbortSignal): Promise<ChatHistory> {
  const data = await api.get<Omit<ChatHistory, 'replies'> & { replies?: UIMessage[] }>(
    `/chat/${encodeURIComponent(threadId)}/messages`,
    { signal },
  );
  if (
    !data?.thread ||
    data.thread.id !== threadId ||
    typeof data.thread.temporary !== 'boolean' ||
    invalidMessages(data.messages) ||
    (data.replies !== undefined && invalidMessages(data.replies))
  )
    throw new Error('Invalid conversation response');
  return { ...data, replies: data.replies ?? [] };
}

/** Persists which reply to the latest turn is active. */
export async function activateReply(threadId: string, messageId: string) {
  await api.patch<{ activeMessageId: string }>(
    `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/active`,
    {},
  );
}
export function messageStatus(message: UIMessage): string | undefined {
  const metadata = message.metadata as { status?: unknown } | undefined;
  return typeof metadata?.status === 'string' ? metadata.status : undefined;
}
export function hasPendingReply(messages: UIMessage[]) {
  return messages.some(
    (message) => message.role === 'assistant' && messageStatus(message) === 'streaming',
  );
}
