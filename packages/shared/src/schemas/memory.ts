import { z } from 'zod';

/**
 * User memory (v0.9): short notes about a person that OCI includes in their
 * system prompt. See docs/dev/v0.9-design.md, "User memory".
 */

/** Characters one memory may hold. */
export const MAX_MEMORY_CHARS = 500;
/** Memories one person may keep. */
export const MAX_MEMORY_ENTRIES = 200;

/** Built-in tool ids the model uses to save and remove memories. */
export const REMEMBER_TOOL_ID = 'remember';
export const FORGET_TOOL_ID = 'forget';
export const MEMORY_TOOL_IDS = [REMEMBER_TOOL_ID, FORGET_TOOL_ID] as const;

export const MEMORY_SOURCES = ['tool', 'person'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Collapses whitespace so a memory is always one line in the prompt. */
export function normalizeMemoryContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export const memoryContentSchema = z
  .string()
  .transform(normalizeMemoryContent)
  .pipe(
    z
      .string()
      .min(1, 'Write something to remember.')
      .max(MAX_MEMORY_CHARS, `A memory can be at most ${MAX_MEMORY_CHARS} characters.`),
  );

export const memoryEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.enum(MEMORY_SOURCES),
  /** The conversation a tool-made memory came from, while it still exists. */
  threadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/** `GET /api/memory`: the person's switch, whether memory can be used at all, and every entry. */
export const memoryStateSchema = z.object({
  /** The person's own opt-in. */
  enabled: z.boolean(),
  /** The instance switch and the person's role both allow memory. */
  available: z.boolean(),
  entries: z.array(memoryEntrySchema),
  limits: z.object({ maxEntries: z.number().int(), maxChars: z.number().int() }),
});
export type MemoryState = z.infer<typeof memoryStateSchema>;

export const updateMemorySettingsSchema = z.object({ enabled: z.boolean() }).strict();
export const createMemorySchema = z.object({ content: memoryContentSchema }).strict();
export const updateMemorySchema = z.object({ content: memoryContentSchema }).strict();

/** `POST /api/memory/undo`: reverses one `remember` or `forget` step of the person's own reply. */
export const undoMemorySchema = z
  .object({
    messageId: z.string().min(1).max(200),
    toolCallId: z.string().min(1).max(200),
  })
  .strict();
export type UndoMemoryInput = z.infer<typeof undoMemorySchema>;

/**
 * What `remember` and `forget` return; stored on the reply's tool part.
 * `exists` means `remember` found the same note already saved and changed
 * nothing, so there is nothing to undo.
 */
export interface MemoryToolResult {
  action: 'added' | 'removed' | 'exists';
  id: string;
  content: string;
}

/** The memory change a finished `remember` or `forget` tool part made, or null. */
export function memoryChangeOf(
  part: Record<string, unknown>,
): (MemoryToolResult & { action: 'added' | 'removed' }) | null {
  if (part.type !== `tool-${REMEMBER_TOOL_ID}` && part.type !== `tool-${FORGET_TOOL_ID}`)
    return null;
  if (part.state !== 'output-available') return null;
  const output = part.output as Partial<MemoryToolResult> | null | undefined;
  if (
    (output?.action !== 'added' && output?.action !== 'removed') ||
    typeof output.id !== 'string' ||
    typeof output.content !== 'string'
  )
    return null;
  return { action: output.action, id: output.id, content: output.content };
}
