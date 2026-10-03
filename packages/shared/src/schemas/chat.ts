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
  /** The project this conversation belongs to, if any. */
  projectId: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Conversation search marks matched words with these control characters rather
 * than HTML, so a snippet is always plain text and clients build highlighting
 * from text nodes. They are stripped from stored text before highlighting, so
 * a message cannot forge them.
 */
export const SEARCH_HIGHLIGHT_START = '\u0001';
export const SEARCH_HIGHLIGHT_END = '\u0002';
export const THREAD_SEARCH_DEFAULT_LIMIT = 20;
export const THREAD_SEARCH_MAX_LIMIT = 50;

export const threadSearchMatchSchema = z.object({
  messageId: z.string(),
  role: z.enum(['user', 'assistant']),
  /** Plain text with SEARCH_HIGHLIGHT_START/END around matched words. */
  snippet: z.string(),
});

export const threadSearchResultSchema = z.object({
  thread: threadSummarySchema,
  rank: z.number(),
  /** The title with matched words marked; identical to the title when only message text matched. */
  titleHighlight: z.string(),
  /** Up to three best-matching messages, best first. Empty when only the title matched. */
  matches: z.array(threadSearchMatchSchema),
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
  /** Set when the search failed; the reply went ahead without results. */
  error: z.string().optional(),
  /**
   * The provider that answered, by name (v0.10). Absent on replies from
   * before v0.10 and when the search failed.
   */
  provider: z.string().optional(),
  /** True when the fallback provider answered because the first one failed (v0.10). */
  fallback: z.boolean().optional(),
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

/**
 * One file in Settings → Attachments (v0.9.1): a chat file, or a project
 * file with the project it belongs to.
 */
export const storedFileSchema = attachmentSchema.extend({
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/** GET /api/threads?view=history: one page, newest activity first. */
export const THREAD_HISTORY_PAGE_SIZE = 50;
export const THREAD_HISTORY_MAX_PAGE_SIZE = 200;

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

/** Longest conversation title, after trimming; renaming enforces the same. */
export const THREAD_TITLE_MAX_LENGTH = 200;

export const createThreadSchema = z
  .object({
    title: z.string().trim().max(THREAD_TITLE_MAX_LENGTH).optional(),
    temporary: z.boolean().default(false),
    /** Start the conversation inside one of the caller's projects. */
    projectId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(THREAD_TITLE_MAX_LENGTH).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** Move into one of the caller's projects, or `null` to take it out. */
  projectId: z.string().min(1).max(200).nullable().optional(),
});

export const forkMessageSchema = z.object({ messageId: z.string().min(1).max(200) }).strict();

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
    /**
     * Project files to leave out of this message's context (v0.10), by id.
     * Each must be a file of the conversation's project; at most a project's
     * file limit (MAX_FILES_PER_PROJECT, 20). Absent means none.
     */
    excludedProjectFileIds: z.array(z.string().min(1).max(200)).max(20).optional(),
    temporary: z.boolean().default(false),
    trigger: z.enum(['submit-message', 'regenerate-message']).default('submit-message'),
  })
  .strict();

export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ThreadSearchMatch = z.infer<typeof threadSearchMatchSchema>;
export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;
export type ForkMessageInput = z.infer<typeof forkMessageSchema>;
export type BranchMessageInput = z.infer<typeof branchMessageSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type SearchGroundingData = z.infer<typeof searchGroundingDataSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type StoredFile = z.infer<typeof storedFileSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
