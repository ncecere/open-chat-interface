import { isToolPart, toolIdOfPart } from '@oci/shared';
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

type HistoryPart = UIMessage['parts'][number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A finished tool step as later turns see it: only the fields the model needs,
 * never provider metadata. Unfinished steps (a stopped reply, an approval that
 * was never answered) are left out so no call is ever left dangling.
 */
function finishedToolStep(part: Record<string, unknown>): Record<string, unknown> | null {
  if (!isToolPart(part) || part.type === 'dynamic-tool') return null;
  const base = { type: part.type, toolCallId: part.toolCallId, input: part.input ?? {} };
  if (part.state === 'output-available')
    return { ...base, state: 'output-available', output: part.output ?? null };
  if (part.state === 'output-error')
    return {
      ...base,
      state: 'output-error',
      errorText: typeof part.errorText === 'string' ? part.errorText : 'The tool failed.',
    };
  if (part.state === 'output-denied') {
    const reason = (part.approval as { reason?: unknown } | undefined)?.reason;
    return {
      ...base,
      state: 'output-error',
      errorText: `The person did not approve this call${typeof reason === 'string' ? ` (${reason})` : ''}.`,
    };
  }
  return null;
}

function toolStepText(step: Record<string, unknown>): string {
  const toolId = toolIdOfPart(step);
  const result =
    step.state === 'output-available' ? JSON.stringify(step.output) : String(step.errorText);
  return `[Tool step: ${toolId} was called with ${JSON.stringify(step.input)}. Result: ${result}]`;
}

/**
 * Parts of a stored message for model context: text, plus finished tool steps.
 * When this turn offers tools they stay tool parts; otherwise they become a
 * short text note, because providers refuse tool history without tools.
 */
export function historyParts(parts: unknown, toolsOffered: boolean): HistoryPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): HistoryPart[] => {
    if (!isRecord(part)) return [];
    if (part.type === 'text' && typeof part.text === 'string')
      return [{ type: 'text', text: part.text }];
    const step = finishedToolStep(part);
    if (!step) return [];
    return toolsOffered
      ? [step as unknown as HistoryPart]
      : [{ type: 'text', text: toolStepText(step) }];
  });
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

type FilePart = { type: 'data-attachment'; data: { id: string } };

/**
 * An edited question's parts: the new text, then the files the question was
 * sent with (#296), as a fork and Retry keep them, less any the person removed
 * in the edit box (`keep`, when given). Only the stored question's own file
 * references are copied, never anything the client sends; the files stay
 * allocated to the original question and are read through it, as a fork's are.
 */
export function editedQuestionParts(stored: unknown, text: string, keep?: string[]) {
  const files = (Array.isArray(stored) ? stored : []).filter(
    (part): part is FilePart =>
      isRecord(part) &&
      part.type === 'data-attachment' &&
      isRecord(part.data) &&
      typeof part.data.id === 'string' &&
      part.data.id.length > 0,
  );
  const own = new Set(files.map((part) => part.data.id));
  if (keep?.some((id) => !own.has(id)))
    throw validationFailed('Only files sent with this message can be kept');
  return [
    { type: 'text', text },
    ...files.filter((part) => !keep || keep.includes(part.data.id)),
  ] as Record<string, unknown>[];
}
