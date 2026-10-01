import { asc, eq, schema } from '@oci/db';
import { db } from '../db/index.js';

/** Bounds a pathological thread rather than streaming an unbounded response. */
export const MAX_EXPORT_MESSAGES = 2_000;

export interface ExportMessage {
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

/** A filesystem-safe slug derived from a conversation title. */
export function safeTitleSlug(title: string): string {
  const safe = title
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase();

  return safe || 'conversation';
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
    .where(eq(schema.message.threadId, threadId))
    .orderBy(asc(schema.message.position))
    .limit(MAX_EXPORT_MESSAGES);

  return renderMarkdown(thread, messages);
}
