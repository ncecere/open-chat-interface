import { and, asc, eq, schema } from '@oci/db';
import {
  isToolPart,
  summarizeToolPart,
  TOOL_LIMIT_REASONS,
  type ToolLimitReason,
  toolLimitNote,
} from '@oci/shared';
import { db } from '../db/index.js';
import { activeMessage } from './chat/reply-path.js';

/** Bounds a pathological thread rather than streaming an unbounded response. */
export const MAX_EXPORT_MESSAGES = 2_000;

interface ExportMessage {
  role: string;
  parts: Record<string, unknown>[];
  modelSlug: string | null;
  status: string;
  createdAt: Date;
}

function textFromParts(parts: Record<string, unknown>[]): string {
  return parts
    .flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text.trim()] : [],
    )
    .filter(Boolean)
    .join('\n\n');
}

function attachmentsFromParts(parts: Record<string, unknown>[]): string[] {
  return parts.flatMap((part) => {
    if (part.type !== 'data-attachment') return [];
    const data = part.data as { filename?: unknown } | undefined;
    return typeof data?.filename === 'string' ? [data.filename] : [];
  });
}

function sourcesFromParts(parts: Record<string, unknown>[]): Array<{ title: string; url: string }> {
  return parts.flatMap((part) => {
    if (part.type !== 'source-url' || typeof part.url !== 'string') return [];
    return [{ title: typeof part.title === 'string' ? part.title : part.url, url: part.url }];
  });
}

/**
 * Tool steps as exports carry them: the tool, its inputs and a one-line
 * summary, never the raw result (which can hold whole pages of fetched text).
 */
export function exportableParts(parts: Record<string, unknown>[]): Record<string, unknown>[] {
  return parts.map((part) => {
    if (!isToolPart(part)) return part;
    const step = summarizeToolPart(part);
    const approval = part.approval as { approved?: unknown; reason?: unknown } | undefined;
    return {
      type: part.type,
      ...(part.type === 'dynamic-tool' ? { toolName: part.toolName } : {}),
      toolCallId: part.toolCallId,
      state: part.state,
      input: part.input ?? null,
      summary: step.summary,
      ...(approval && typeof approval.approved === 'boolean'
        ? {
            approval: {
              approved: approval.approved,
              ...(typeof approval.reason === 'string' ? { reason: approval.reason } : {}),
            },
          }
        : {}),
    };
  });
}

function toolLinesFromParts(parts: Record<string, unknown>[]): string[] {
  const lines = parts.filter(isToolPart).map((part) => `_${summarizeToolPart(part).summary}_`);
  const limit = parts.find((part) => part.type === 'data-tool-limit')?.data as
    | { reason?: unknown; steps?: unknown }
    | undefined;
  if (limit && TOOL_LIMIT_REASONS.includes(limit.reason as ToolLimitReason))
    lines.push(
      `_${toolLimitNote(limit.reason as ToolLimitReason, typeof limit.steps === 'number' ? limit.steps : undefined)}_`,
    );
  return lines;
}

/**
 * Renders one conversation as Markdown.
 *
 * Reasoning is omitted: it is a model's working rather than its answer, and
 * including it would make an export read as though the assistant said things
 * it never presented. Attachments appear by name only, since the bytes live in
 * object storage and a Markdown file cannot carry them.
 */
export function renderMarkdown(
  thread: { title: string; createdAt: Date },
  messages: ExportMessage[],
): string {
  const lines: string[] = [
    `# ${thread.title}`,
    '',
    `Exported ${new Date().toISOString().slice(0, 10)} · started ${thread.createdAt
      .toISOString()
      .slice(0, 10)}`,
    '',
  ];

  for (const message of messages) {
    if (message.role === 'system') continue;

    const heading =
      message.role === 'user'
        ? '## You'
        : `## Assistant${message.modelSlug ? ` · ${message.modelSlug}` : ''}`;
    lines.push(heading, '');

    if (message.status === 'error') {
      lines.push('_This response failed._', '');
      continue;
    }
    if (message.status === 'cancelled') {
      lines.push('_This response was stopped early._', '');
    }

    const attachments = attachmentsFromParts(message.parts);
    if (attachments.length > 0) {
      lines.push(`_Attached: ${attachments.join(', ')}_`, '');
    }

    const steps = toolLinesFromParts(message.parts);
    if (steps.length > 0) lines.push(...steps, '');

    const text = textFromParts(message.parts);
    if (text) lines.push(text, '');

    const sources = sourcesFromParts(message.parts);
    if (sources.length > 0) {
      lines.push('**Sources**', '');
      for (const source of sources) lines.push(`- [${source.title}](${source.url})`);
      lines.push('');
    }
  }

  if (messages.length >= MAX_EXPORT_MESSAGES) {
    lines.push(`_Truncated at ${MAX_EXPORT_MESSAGES} messages._`, '');
  }

  return lines.join('\n');
}

/** A filesystem-safe slug derived from a title, or `fallback` when nothing is left. */
export function safeTitleSlug(title: string, fallback = 'conversation'): string {
  const safe = title
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase();

  return safe || fallback;
}

/** A filesystem-safe name derived from the conversation title. */
export function exportFilename(title: string): string {
  return `${safeTitleSlug(title)}-${new Date().toISOString().slice(0, 10)}.md`;
}

/** Ownership is enforced by the caller before this runs. */
export async function exportThreadMarkdown(threadId: string): Promise<string> {
  const [thread] = await db
    .select({ title: schema.thread.title, createdAt: schema.thread.createdAt })
    .from(schema.thread)
    .where(eq(schema.thread.id, threadId))
    .limit(1);

  if (!thread) throw new Error('Thread not found');

  const messages = await db
    .select({
      role: schema.message.role,
      parts: schema.message.parts,
      modelSlug: schema.message.modelSlug,
      status: schema.message.status,
      createdAt: schema.message.createdAt,
    })
    .from(schema.message)
    // The conversation as it reads: replies a retry replaced are left out.
    .where(and(eq(schema.message.threadId, threadId), activeMessage()))
    .orderBy(asc(schema.message.position))
    .limit(MAX_EXPORT_MESSAGES);

  return renderMarkdown(thread, messages);
}
