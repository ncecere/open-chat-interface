import type { UIMessage } from 'ai';
import { api } from './api-client';

export interface ChatHistory {
  thread: { id: string; temporary: boolean; expiresAt: string | null };
  messages: UIMessage[];
}
export async function getChatHistory(threadId: string, signal?: AbortSignal) {
  const data = await api.get<ChatHistory>(`/chat/${encodeURIComponent(threadId)}/messages`, {
    signal,
  });
  if (
    !data?.thread ||
    data.thread.id !== threadId ||
    typeof data.thread.temporary !== 'boolean' ||
    !Array.isArray(data.messages) ||
    data.messages.some(
      (message) =>
        !message ||
        typeof message.id !== 'string' ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        !Array.isArray(message.parts) ||
        message.parts.some((part) => !part || typeof part.type !== 'string'),
    )
  )
    throw new Error('Invalid conversation response');
  return data;
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
