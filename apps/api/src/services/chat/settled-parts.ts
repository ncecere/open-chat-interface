import type { UIMessage } from 'ai';

/**
 * A reply's parts once nothing more will arrive: text and reasoning are as
 * written, and a tool call whose input never finished was never run, so it is
 * left out. A reply stopped while the model was still writing a tool call
 * (an artifact, say) was otherwise stored with that call stuck at
 * input-streaming, and read as if it had been made.
 */
export function settledParts(parts: UIMessage['parts']): UIMessage['parts'] {
  return parts.flatMap((part) => {
    const state = (part as { state?: unknown }).state;
    if ((part.type === 'text' || part.type === 'reasoning') && state === 'streaming')
      return [{ ...part, state: 'done' as const }];
    if (state === 'input-streaming') return [];
    return [part];
  });
}
