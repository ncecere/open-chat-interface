import { and, asc, eq, inArray, schema } from '@oci/db';
import {
  ARTIFACT_KIND_LABELS,
  type ArtifactKind,
  artifactOfToolPart,
  isToolPart,
  summarizeToolPart,
  TOOL_LIMIT_REASONS,
  type ToolLimitReason,
  toolLimitNote,
} from '@oci/shared';
import { db } from '../db/index.js';
import { artifactsWithVersions } from './artifacts/store.js';
import { currentAppName } from './branding.js';
import { activeMessage } from './chat/reply-path.js';

/**
 * The time zone a download is dated in: the person's, as their browser gives
 * it, so an evening export is not dated tomorrow (#211). UTC for an unknown
 * zone or none (the full-data export runs in the background, with no browser).
 */
export function exportTimeZone(value: string | undefined | null): string {
  if (!value) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** A day as YYYY-MM-DD in `timeZone`. */
export function dayIn(date: Date, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Bounds a pathological thread rather than streaming an unbounded response. */
export const MAX_EXPORT_MESSAGES = 2_000;

interface ExportMessage {
  /** Needed to show which artifacts a reply made; absent in older callers. */
  id?: string;
  role: string;
  parts: Record<string, unknown>[];
  modelSlug: string | null;
  status: string;
  createdAt: Date;
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

/**
 * A reply's tool steps (one summary line each) and text, in the order they
 * were written: each run of tool steps, then the text after it, and so on.
 * The note of a reply that hit its tool limit follows its last tool step.
 * Each block ends with a blank line.
 */
export function orderedReplyLines(
  parts: Record<string, unknown>[],
  /** Tool steps said another way (an artifact a reply made has its own line). */
  skip: (part: Record<string, unknown>) => boolean = () => false,
): string[] {
  const blocks: Array<{ type: 'tools' | 'text'; lines: string[] }> = [];
  const add = (type: 'tools' | 'text', line: string) => {
    const last = blocks.at(-1);
    if (last?.type === type) last.lines.push(line);
    else blocks.push({ type, lines: [line] });
  };
  for (const part of parts) {
    if (isToolPart(part)) {
      if (!skip(part)) add('tools', `_${summarizeToolPart(part).summary}_`);
    } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim())
      add('text', part.text.trim());
  }
  const limit = parts.find((part) => part.type === 'data-tool-limit')?.data as
    | { reason?: unknown; steps?: unknown }
    | undefined;
  if (limit && TOOL_LIMIT_REASONS.includes(limit.reason as ToolLimitReason)) {
    const note = `_${toolLimitNote(limit.reason as ToolLimitReason, typeof limit.steps === 'number' ? limit.steps : undefined)}_`;
    const lastTools = blocks.findLastIndex((block) => block.type === 'tools');
    if (lastTools === -1) blocks.unshift({ type: 'tools', lines: [note] });
    else blocks[lastTools]?.lines.push(note);
  }
  return blocks.flatMap((block) => [block.lines.join(block.type === 'text' ? '\n\n' : '\n'), '']);
}

/** An artifact as Markdown exports reference it (the JSON export carries the content). */
interface ExportArtifactReference {
  /** Matches a reply's artifact tool step to this artifact; absent in older callers. */
  id?: string;
  messageId: string;
  title: string;
  kind: ArtifactKind;
  /** Versions made by each reply, so a reply that revised an artifact says so. */
  versions: Array<{ version: number; messageId: string | null }>;
}

/**
 * The artifact versions a message made, each with its line: "Artifact 'Report'
 * (HTML, version 2)". The last version the export lists says when a newer one
 * exists, made by hand or by a reply not exported (#211).
 */
function artifactLines(
  messageId: string | undefined,
  artifacts: readonly ExportArtifactReference[],
  /** The messages this export holds. */
  exported: ReadonlySet<string>,
): Array<{ key: string | null; line: string }> {
  if (!messageId) return [];
  return artifacts.flatMap((artifact) => {
    const latest = Math.max(...artifact.versions.map((version) => version.version));
    const lastListed = Math.max(
      ...artifact.versions
        .filter((version) => version.messageId !== null && exported.has(version.messageId))
        .map((version) => version.version),
    );
    return artifact.versions
      .filter((version) => version.messageId === messageId)
      .map((version) => ({
        key: artifact.id ? `${artifact.id}:${version.version}` : null,
        line: `_Artifact \u201c${artifact.title}\u201d (${ARTIFACT_KIND_LABELS[artifact.kind]}, version ${version.version}${
          version.version === lastListed && version.version < latest
            ? `; the latest is version ${latest}`
            : ''
        })_`,
      }));
  });
}

/**
 * Display names for the models that wrote replies, by slug, as the app shows
 * them ("GPT-4.1 mini", not "gpt-4-1-mini"; #152). A model since deleted has
 * none, and its reply keeps the slug.
 */
export async function modelDisplayNames(
  organizationId: string,
  messages: ReadonlyArray<{ modelSlug: string | null }>,
): Promise<Map<string, string>> {
  const slugs = [...new Set(messages.flatMap((message) => message.modelSlug ?? []))];
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ slug: schema.model.slug, displayName: schema.model.displayName })
    .from(schema.model)
    .where(and(eq(schema.model.organizationId, organizationId), inArray(schema.model.slug, slugs)));
  return new Map(rows.map((row) => [row.slug, row.displayName]));
}

/**
 * Renders one conversation as Markdown.
 *
 * Reasoning is omitted: it is a model's working rather than its answer, and
 * including it would make an export read as though the assistant said things
 * it never presented. Attachments appear by name only, since the bytes live in
 * object storage and a Markdown file cannot carry them.
 *
 * `source` is the instance name (Branding > App name) the header says the
 * file came from; without it the header gives only the dates.
 */
export function renderMarkdown(
  thread: { title: string; createdAt: Date },
  messages: ExportMessage[],
  artifacts: readonly ExportArtifactReference[] = [],
  source?: string,
  /** Model display names by slug (modelDisplayNames); a missing one shows the slug. */
  modelNames: ReadonlyMap<string, string> = new Map(),
  /** The zone the dates are given in (exportTimeZone). */
  timeZone = 'UTC',
): string {
  const lines: string[] = [
    `# ${thread.title}`,
    '',
    `Exported${source ? ` from ${source} on` : ''} ${dayIn(new Date(), timeZone)} · started ${dayIn(
      thread.createdAt,
      timeZone,
    )}`,
    '',
  ];

  const exported = new Set(messages.flatMap((message) => message.id ?? []));
  for (const message of messages) {
    if (message.role === 'system') continue;

    const heading =
      message.role === 'user'
        ? '## You'
        : `## Assistant${message.modelSlug ? ` · ${modelNames.get(message.modelSlug) ?? message.modelSlug}` : ''}`;
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

    // Tool steps and text in the order the reply wrote them. A step that made
    // an artifact listed below is left out, so each artifact is named once,
    // with its kind and version (#152).
    const made = artifactLines(message.id, artifacts, exported);
    const listed = new Set(made.flatMap((entry) => entry.key ?? []));
    lines.push(
      ...orderedReplyLines(message.parts, (part) => {
        const artifact = artifactOfToolPart(part);
        return artifact !== null && listed.has(`${artifact.artifactId}:${artifact.version}`);
      }),
    );

    if (made.length > 0) lines.push(...made.map((entry) => entry.line), '');

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
export function exportFilename(title: string, timeZone = 'UTC'): string {
  return `${safeTitleSlug(title)}-${dayIn(new Date(), timeZone)}.md`;
}

/** Ownership is enforced by the caller before this runs. */
export async function exportThreadMarkdown(
  threadId: string,
  userId: string,
  timeZone = 'UTC',
): Promise<string> {
  const [thread] = await db
    .select({
      title: schema.thread.title,
      createdAt: schema.thread.createdAt,
      organizationId: schema.thread.organizationId,
    })
    .from(schema.thread)
    .where(eq(schema.thread.id, threadId))
    .limit(1);

  if (!thread) throw new Error('Thread not found');

  const messages = await db
    .select({
      id: schema.message.id,
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

  const artifacts = await artifactsWithVersions(
    threadId,
    userId,
    messages.map((message) => message.id),
  );
  return renderMarkdown(
    thread,
    messages,
    artifacts,
    await currentAppName(),
    await modelDisplayNames(thread.organizationId, messages),
    timeZone,
  );
}
