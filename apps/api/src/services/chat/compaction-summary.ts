import { generateText } from 'ai';
import { validationFailed } from '../../lib/errors.js';
import {
  chunkTranscript,
  groupTurns,
  MIN_CHUNK_UNITS,
  SUMMARY_PROMPT_OVERHEAD,
  SUMMARY_SYSTEM,
  serializeConversation,
  summaryPrompt,
} from './compaction-plan.js';
import type { CompactionPlan } from './compaction-span.js';
import { contextBudget } from './context-budget.js';
import type { TurnContext } from './turn-context.js';

export type SummaryModel = Pick<
  TurnContext['resolved'],
  'slug' | 'languageModel' | 'contextWindow' | 'maxOutputTokens'
>;

/** Upper bound for one summary, in tokens. */
const MAX_SUMMARY_TOKENS = 4096;
const SUMMARY_TIMEOUT_MS = 120_000;

/**
 * The most a summary may be, in tokens: small beside the input budget, so the
 * kept turns and the summary fit together.
 */
export function summaryMaxTokens(budget: { units: number; outputTokens: number }): number {
  return Math.max(
    256,
    Math.min(budget.outputTokens, MAX_SUMMARY_TOKENS, Math.floor(budget.units / 16)),
  );
}

/**
 * Room for transcript in one summariser call, beside its instructions, the
 * previous summary and the summary it writes. Refused when too small.
 */
export function summaryChunkUnits(
  model: SummaryModel,
  previousSummary: string | null,
  instructions: string | null | undefined,
): number {
  const budget = contextBudget(model);
  const fixed =
    SUMMARY_PROMPT_OVERHEAD +
    Buffer.byteLength(SUMMARY_SYSTEM) +
    Buffer.byteLength(instructions ?? '') +
    Math.max(Buffer.byteLength(previousSummary ?? ''), summaryMaxTokens(budget) * 4);
  const chunkUnits = budget.units - fixed;
  if (chunkUnits < MIN_CHUNK_UNITS)
    throw validationFailed('The model’s input limit is too small to summarise this conversation');
  return chunkUnits;
}

export type Tally = {
  inputTokens: number;
  outputTokens: number;
  /** Calls that returned. */
  calls: number;
  /** Whether any call was made, even one that then failed. */
  started: boolean;
  complete: boolean;
};

/**
 * The summary: the previous summary carried forward, updated with each chunk
 * of transcript in turn. One call for any ordinary backlog.
 */
export async function summarize(
  plan: CompactionPlan,
  model: SummaryModel,
  instructions: string | null | undefined,
  tally: Tally,
): Promise<string> {
  const maxOutputTokens = summaryMaxTokens(contextBudget(model));
  let summary = plan.previous?.summary ?? null;
  const chunkUnits = summaryChunkUnits(model, summary, instructions);
  const turns = groupTurns(plan.summarized, () => 0)
    .map((group) => serializeConversation(group.messages))
    .filter((text) => text.length > 0);
  const { chunks } = chunkTranscript(turns, chunkUnits);
  if (!chunks.length) return summary ?? 'The earlier messages contained no text.';
  for (const transcript of chunks) {
    tally.started = true;
    const result = await generateText({
      model: model.languageModel,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt({ transcript, previousSummary: summary, instructions }),
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    tally.calls++;
    const { inputTokens, outputTokens } = result.totalUsage;
    if (inputTokens == null || outputTokens == null) tally.complete = false;
    tally.inputTokens += inputTokens ?? 0;
    tally.outputTokens += outputTokens ?? 0;
    const text = result.text.trim();
    if (!text) throw new Error('The model returned an empty summary');
    summary = text;
  }
  return summary!;
}
