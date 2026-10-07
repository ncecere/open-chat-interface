import { z } from 'zod';

/**
 * Conversation compaction (v0.9): a conversation's earlier turns summarised so
 * it keeps fitting the model's input. See docs/user/conversations.md.
 */
export const COMPACTION_REASONS = ['automatic', 'manual'] as const;
export type CompactionReason = (typeof COMPACTION_REASONS)[number];

/** Optional focus a person gives a manual compaction ("keep the budget figures"). */
export const COMPACTION_INSTRUCTIONS_MAX_LENGTH = 2000;

export const compactThreadSchema = z
  .object({
    instructions: z.string().trim().max(COMPACTION_INSTRUCTIONS_MAX_LENGTH).optional(),
    /**
     * The model to summarise with and size the kept turns for: the one
     * selected in the composer. Without one, the conversation's latest reply's
     * model, or the person's default when that reply failed (#363).
     */
    modelSlug: z.string().min(1).max(200).optional(),
  })
  .strict();

export const conversationCompactionSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** Messages from this one on are sent to the model verbatim. */
  firstKeptMessageId: z.string(),
  summary: z.string(),
  reason: z.enum(COMPACTION_REASONS),
  messagesSummarized: z.number().int(),
  tokensSummarized: z.number().int(),
  modelSlug: z.string(),
  createdAt: z.string(),
});

/**
 * Why a summary the person asked for failed (v0.10): their allowance was
 * spent, the model failed or refused, there was nothing to summarise by the
 * time it ran, or the model took too long.
 */
export const COMPACTION_FAILURE_REASONS = [
  'allowance',
  'model_error',
  'nothing_to_summarise',
  'timeout',
] as const;
export type CompactionFailureReason = (typeof COMPACTION_FAILURE_REASONS)[number];

/** The last failed manual summary, until dismissed, asked for again or followed by a success. */
export const compactionFailureSchema = z.object({
  reason: z.enum(COMPACTION_FAILURE_REASONS),
  /** The failed request's instructions, so Retry can ask for the same summary. */
  instructions: z.string().nullable(),
  failedAt: z.string(),
});

/**
 * What `GET /api/threads/:id/compaction` and `POST /api/threads/:id/compact`
 * return: the summary in use, whether a background summary is queued or
 * running (one waiting for a later retry is not reported as pending), and
 * the last failure of a summary the person asked for (never an automatic one).
 */
export const compactionStateSchema = z.object({
  compaction: conversationCompactionSchema.nullable(),
  pending: z.boolean(),
  failure: compactionFailureSchema.nullable(),
  /**
   * Whether asking for a summary now has anything to summarise (two turns
   * since the previous cut; #153). Absent from servers before it was added,
   * which offered the control regardless.
   */
  summarisable: z.boolean().optional(),
});

export type CompactionState = z.infer<typeof compactionStateSchema>;
export type CompactionFailure = z.infer<typeof compactionFailureSchema>;
export type CompactThreadInput = z.infer<typeof compactThreadSchema>;
export type ConversationCompaction = z.infer<typeof conversationCompactionSchema>;
