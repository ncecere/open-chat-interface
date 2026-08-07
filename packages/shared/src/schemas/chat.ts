import { z } from 'zod';
import { REASONING_EFFORTS } from '../constants.js';

export const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  temporary: z.boolean(),
  expiresAt: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  branchedFromMessageId: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const searchGroundingDataSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
    }),
  ),
});

export const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  url: z.string(),
  thumbnailUrl: z.string().nullable(),
  createdAt: z.string(),
});

export const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.record(z.string(), z.unknown())),
  modelSlug: z.string().nullable(),
  effort: z.enum(REASONING_EFFORTS).nullable(),
  attachments: z.array(attachmentSchema).default([]),
  parentMessageId: z.string().nullable(),
  status: z.enum(['streaming', 'complete', 'error', 'cancelled']),
  errorMessage: z.string().nullable(),
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});

export const createThreadSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    temporary: z.boolean().default(false),
  })
  .strict();

export const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

/** Editing a historical turn always creates a branch; no history is rewritten. */
export const branchMessageSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(100_000),
  })
  .strict();

const inboundTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(100_000),
  })
  .strict();

/**
 * Chat history is rebuilt from the database. The client may submit only the
 * latest user text, preventing crafted file/tool parts from reaching a model.
 */
const inboundUserMessageSchema = z
  .object({
    id: z.string().max(200).optional(),
    role: z.literal('user'),
    parts: z.array(inboundTextPartSchema).min(1).max(20),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    threadId: z.string().min(1),
    messages: z.array(inboundUserMessageSchema).length(1),
    modelSlug: z.string().min(1),
    effort: z.enum(REASONING_EFFORTS).optional(),
    webSearch: z.boolean().default(false),
    attachmentIds: z.array(z.string()).default([]),
    temporary: z.boolean().default(false),
    trigger: z.enum(['submit-message', 'regenerate-message']).default('submit-message'),
  })
  .strict();

export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type BranchMessageInput = z.infer<typeof branchMessageSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type SearchGroundingData = z.infer<typeof searchGroundingDataSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
