import { z } from 'zod';
import { REASONING_EFFORTS } from '../constants.js';

export const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  parentThreadId: z.string().nullable(),
  branchedFromMessageId: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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

export const createThreadSchema = z.object({
  title: z.string().trim().max(200).optional(),
  temporary: z.boolean().default(false),
});

export const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const sendMessageSchema = z.object({
  threadId: z.string().min(1),
  messages: z.array(z.record(z.string(), z.unknown())),
  modelSlug: z.string().min(1),
  effort: z.enum(REASONING_EFFORTS).optional(),
  webSearch: z.boolean().default(false),
  personaId: z.string().nullable().optional(),
  attachmentIds: z.array(z.string()).default([]),
  temporary: z.boolean().default(false),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
