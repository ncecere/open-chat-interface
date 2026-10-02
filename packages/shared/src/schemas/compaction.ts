import { z } from 'zod';

/**
 * Conversation compaction (v0.9): a conversation's earlier turns summarised so
 * it keeps fitting the model's input. See docs/user/conversations.md.
 */
export const COMPACTION_REASONS = ['automatic', 'manual', 'overflow'] as const;
export type CompactionReason = (typeof COMPACTION_REASONS)[number];

/** Optional focus a person gives a manual compaction ("keep the budget figures"). */
export const COMPACTION_INSTRUCTIONS_MAX_LENGTH = 2000;

export const compactThreadSchema = z
  .object({
    instructions: z.string().trim().max(COMPACTION_INSTRUCTIONS_MAX_LENGTH).optional(),
    /**
     * The model to summarise with and size the kept turns for: the one
     * selected in the composer. Defaults to the conversation's latest reply.
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

export type CompactThreadInput = z.infer<typeof compactThreadSchema>;
export type ConversationCompaction = z.infer<typeof conversationCompactionSchema>;
