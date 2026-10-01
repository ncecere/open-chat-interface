import type { UIMessage } from 'ai';
import { validationFailed } from '../../lib/errors.js';

// These are application ceilings, not promises about any provider's tokenizer.
export const MAX_HISTORY_MESSAGES = 128;
export const MAX_HISTORY_BYTES = 512 * 1024;
export const MAX_INPUT_UNITS = 128_000;
export const MAX_CONTEXT_FILES = 32;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_INPUT_UNITS = 8192;
export const MESSAGE_OVERHEAD = 64;
export const PART_OVERHEAD = 16;
const FALLBACK_CONTEXT_WINDOW = 32_768;
const DEFAULT_OUTPUT_TOKENS = 4096;
const SAFETY_MARGIN = 512;

export type ContextCost = { units: number; files: number; imageBytes: number };
export type ContextBudget = ContextCost & { outputTokens: number };
export const emptyCost = (): ContextCost => ({ units: 0, files: 0, imageBytes: 0 });
export function addCost(a: ContextCost, b: ContextCost): ContextCost {
  return {
    units: a.units + b.units,
    files: a.files + b.files,
    imageBytes: a.imageBytes + b.imageBytes,
  };
}
export function textCost(text: string): ContextCost {
  // One unit per UTF-8 byte deliberately avoids optimistic chars/4 estimates.
  return { units: Buffer.byteLength(text, 'utf8') + PART_OVERHEAD, files: 0, imageBytes: 0 };
}
/** Estimate the actual assembled input too, before persisting or invoking a provider. */
export function messageCost(message: UIMessage): ContextCost {
  let cost = { ...emptyCost(), units: MESSAGE_OVERHEAD };
  for (const part of message.parts) {
    if (part.type === 'text') cost = addCost(cost, textCost(part.text));
    else if (
      part.type === 'file' &&
      part.url.startsWith('data:') &&
      part.url.includes(';base64,')
    ) {
      const base64 = part.url.slice(part.url.indexOf(';base64,') + 8);
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      cost = addCost(cost, {
        units: IMAGE_INPUT_UNITS + Buffer.byteLength(part.filename ?? '') + 128,
        files: 1,
        imageBytes: (base64.length * 3) / 4 - padding,
      });
    } else throw validationFailed('Unsupported model input part');
  }
  return cost;
}

export function contextBudget(model: {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): ContextBudget {
  const window = model.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  const outputTokens =
    model.maxOutputTokens ?? Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(window / 4));
  if (
    !Number.isSafeInteger(window) ||
    window <= 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens <= 0
  ) {
    throw validationFailed('The model has an invalid context or output limit');
  }
  const units = Math.min(MAX_INPUT_UNITS, window - outputTokens - SAFETY_MARGIN);
  if (units <= 0) throw validationFailed('The model output limit leaves no room for input');
  return { units, files: MAX_CONTEXT_FILES, imageBytes: MAX_IMAGE_BYTES, outputTokens };
}
export function fitsContext(cost: ContextCost, budget: ContextCost): boolean {
  return (['units', 'files', 'imageBytes'] as const).every(
    (key) => Number.isSafeInteger(cost[key]) && cost[key] >= 0 && cost[key] <= budget[key],
  );
}
export function assertFitsContext(cost: ContextCost, budget: ContextCost) {
  if (!fitsContext(cost, budget))
    throw validationFailed(
      'The latest message, instructions or attachments exceed this model’s input budget. Shorten the request, remove files or choose a model with more context.',
    );
}

/** Drop an incomplete leading fragment; never supply an orphaned assistant reply. */
export function historyGroups<T extends { role: string }>(messages: T[]): T[][] {
  const groups: T[][] = [];
  for (const message of messages) {
    if (message.role === 'user') groups.push([message]);
    else if (message.role === 'assistant') groups.at(-1)?.push(message);
  }
  return groups;
}

/** Keep a contiguous suffix of whole turns, not scattered cheap fragments. */
export function selectContextSuffix<T>(
  groups: Array<{ items: T[]; cost: ContextCost }>,
  required: ContextCost,
  budget: ContextCost,
) {
  assertFitsContext(required, budget);
  let cost = required;
  let first = groups.length;
  for (let index = groups.length - 1; index >= 0; index--) {
    const next = addCost(cost, groups[index]!.cost);
    if (!fitsContext(next, budget)) break;
    cost = next;
    first = index;
  }
  return { items: groups.slice(first).flatMap((group) => group.items), cost, limited: first > 0 };
}
