import type { UIMessage } from 'ai';
import { useEffect } from 'react';
import { failureOf, metadataOf } from '~/components/chat/message-content';

/**
 * The model "Summarise earlier messages now" should use (#363): the one in the
 * composer's picker. The summary control lives in the top bar and the picker
 * in the conversation, so the conversation publishes its choice here and the
 * request reads it when it is made.
 */
const published = new Map<string, string | null>();

/** What the next summary request for a conversation names, or null to let the server choose. */
export function publishedSummaryModel(threadId: string): string | null {
  return published.get(threadId) ?? null;
}

/**
 * The picker's model, unless it is the model whose reply just failed: asking
 * it again would fail the summary the same way, so the request names none and
 * the server uses the person's default model instead.
 */
export function summaryModelChoice(
  messages: readonly UIMessage[],
  picked: string | null | undefined,
): string | null {
  if (!picked) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const { modelSlug } = metadataOf(message);
    if (!modelSlug) continue;
    return modelSlug === picked && failureOf(message) !== null ? null : picked;
  }
  return picked;
}

/** Publishes the conversation's summary model while it is open. */
export function usePublishSummaryModel(
  threadId: string,
  messages: readonly UIMessage[],
  picked: string | null | undefined,
): void {
  const choice = summaryModelChoice(messages, picked);
  useEffect(() => {
    published.set(threadId, choice);
    return () => {
      published.delete(threadId);
    };
  }, [threadId, choice]);
}
