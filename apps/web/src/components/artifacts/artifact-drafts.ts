import {
  ARTIFACT_KINDS,
  ARTIFACT_TOOL_IDS,
  type ArtifactKind,
  artifactOfToolPart,
  isDeclinedArtifactPart,
  isToolPart,
  toolIdOfPart,
} from '@oci/shared';
import type { UIMessage } from 'ai';

/** One find-and-replace pair of an `update_artifact` call, as far as it has arrived. */
interface ArtifactEdit {
  find: string;
  replace: string;
}

/**
 * An artifact tool call as the reply shows it: while the model is still
 * writing its input (`input-streaming`, `input-available`), once saved, or
 * failed. The input is the SDK's progressively parsed partial input, so every
 * field may be missing or cut short while it streams.
 */
export interface ArtifactDraft {
  messageId: string;
  toolCallId: string;
  tool: (typeof ARTIFACT_TOOL_IDS)[number];
  /** `content` writes the whole text; `edits` revises with find-and-replace; `unknown` until one arrives. */
  mode: 'content' | 'edits' | 'unknown';
  title: string | null;
  kind: ArtifactKind | null;
  /** A code artifact's language, as the call gives it (#298). */
  language: string | null;
  /** The text written so far (`content` mode). */
  content: string;
  edits: ArtifactEdit[];
  /** The artifact being revised, or the one saved. */
  artifactId: string | null;
  /** Set once saved: the version this call made. */
  version: number | null;
  state: 'writing' | 'saved' | 'failed';
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** The draft of one tool part, or null when it is not an artifact tool call. */
export function artifactDraftOf(messageId: string, part: unknown): ArtifactDraft | null {
  // Declined as reply content (#201): there is no artifact, not even a failed one.
  if (!isToolPart(part) || isDeclinedArtifactPart(part)) return null;
  const tool = toolIdOfPart(part);
  if (!(ARTIFACT_TOOL_IDS as readonly string[]).includes(tool)) return null;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const result = artifactOfToolPart(part);
  const kind = text(input.kind);
  const edits = Array.isArray(input.edits)
    ? input.edits.flatMap((edit) => {
        const candidate = edit as { find?: unknown; replace?: unknown } | null;
        const find = text(candidate?.find);
        return find === null ? [] : [{ find, replace: text(candidate?.replace) ?? '' }];
      })
    : [];
  const content = text(input.content);
  const mode =
    tool === 'create_artifact' || content !== null
      ? 'content'
      : Array.isArray(input.edits)
        ? 'edits'
        : 'unknown';
  const state =
    part.state === 'output-available' && result
      ? 'saved'
      : part.state === 'input-streaming' || part.state === 'input-available'
        ? 'writing'
        : 'failed';
  const title = result?.title ?? text(input.title)?.trim() ?? null;
  return {
    messageId,
    toolCallId: part.toolCallId,
    tool: tool as ArtifactDraft['tool'],
    mode,
    title: title || null,
    kind: (ARTIFACT_KINDS as readonly string[]).includes(kind ?? '')
      ? (kind as ArtifactKind)
      : null,
    language: text(input.language),
    content: content ?? '',
    edits,
    artifactId: result?.artifactId ?? text(input.artifactId),
    version: result?.version ?? null,
    state,
  };
}

/** Every artifact tool call of a reply, in order. */
export function artifactDraftsOf(message: UIMessage): ArtifactDraft[] {
  return message.parts.flatMap((part) => {
    const draft = artifactDraftOf(message.id, part);
    return draft ? [draft] : [];
  });
}

/** Whether the panel can show this call's text as it is written. */
export const writesSource = (draft: ArtifactDraft) => draft.mode === 'content';

/** "12 lines · 340 characters" */
export function sizeLabel(content: string): string {
  // A final newline ends the last line rather than starting another.
  const lines = content ? content.replace(/\n$/, '').split('\n').length : 0;
  const format = new Intl.NumberFormat();
  return `${format.format(lines)} ${lines === 1 ? 'line' : 'lines'} · ${format.format(
    content.length,
  )} ${content.length === 1 ? 'character' : 'characters'}`;
}
