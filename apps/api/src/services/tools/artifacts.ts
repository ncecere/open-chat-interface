import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_KINDS,
  type ArtifactKind,
  applyArtifactEdits,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_EDITS,
  MAX_ARTIFACT_TITLE_LENGTH,
  toolKey,
} from '@oci/shared';
import { z } from 'zod';
import { validationFailed } from '../../lib/errors.js';
import { markdownArtifactRefusal, personAskedForArtifact } from '../artifacts/markdown-floor.js';
import { addArtifactVersion, createArtifact, currentContent } from '../artifacts/store.js';
import { roleFeatures } from '../role-features.js';
import type { ToolDefinition } from './types.js';

/**
 * The artifact tools (v0.9). They change only OCI's own data in the current
 * conversation (an artifact and its versions, which the person can see, copy
 * and delete with the conversation), like the reply itself, so they use read
 * semantics: no approval. They are governed by the role's `artifacts` switch
 * rather than the per-tool list, and are offered to every tool-capable model
 * when that switch is on. See docs/dev/v0.9-design.md, "Artifacts".
 */

/** What a successful call returns to the model; also read by every renderer. */
interface ArtifactToolResult {
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  sizeBytes: number;
}

const available: ToolDefinition['available'] = async (turn) =>
  (await roleFeatures(turn.role)).artifacts;

const contentSchema = z
  .string()
  .min(1)
  // Characters are at most bytes; the exact UTF-8 limit is checked on save.
  .max(MAX_ARTIFACT_BYTES);

const createArtifactTool: ToolDefinition = {
  id: 'create_artifact',
  label: 'Create artifact',
  description: [
    'Save content the person will want to see rendered as an artifact they can open, preview, copy and download:',
    'an HTML page or small app (a complete, self-contained document), an SVG image or diagram,',
    'a Mermaid diagram, or a long prose document they asked for (a report, letter or plan) as Markdown.',
    'Never use it for program code: write code in fenced code blocks in your reply, one per language or file.',
    'Never use it for tables, lists or short answers: write those in your reply.',
    'Do not repeat the content in your reply or link to it; a card appears on its own. Returns the artifact id for later updates.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(MAX_ARTIFACT_TITLE_LENGTH).describe('A short title'),
    kind: z.enum(ARTIFACT_KINDS).describe('html, svg, mermaid or markdown'),
    content: contentSchema.describe('The full content'),
  }),
  available,
  async execute(input, { caller, toolCallId }) {
    const { title, kind, content } = input as {
      title: string;
      kind: ArtifactKind;
      content: string;
    };
    // The guidance alone did not stop small tables and functions becoming
    // Markdown artifacts (#149); see artifacts/markdown-floor.ts.
    if (kind === 'markdown') {
      const refusal = markdownArtifactRefusal(content);
      if (refusal && !(await personAskedForArtifact(caller.threadId)))
        throw validationFailed(refusal);
    }
    const { artifact } = await createArtifact({
      userId: caller.userId,
      role: caller.role,
      threadId: caller.threadId,
      messageId: caller.messageId,
      sourceKey: toolKey(toolCallId ?? crypto.randomUUID()),
      title,
      kind,
      content,
    });
    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.currentVersion,
      sizeBytes: artifact.sizeBytes,
    } satisfies ArtifactToolResult;
  },
};

const updateArtifactTool: ToolDefinition = {
  id: 'update_artifact',
  label: 'Update artifact',
  description: [
    'Revise an artifact of this conversation, which saves a new version.',
    'Prefer `edits`: find-and-replace pairs applied in order, where each `find` is exact text that',
    'occurs exactly once in the current version. Send `content` instead only to replace everything.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    artifactId: z.string().trim().min(1).max(100).describe('The artifact id'),
    content: contentSchema.optional().describe('The complete new content'),
    edits: z
      .array(
        z.object({
          find: z.string().min(1).max(20_000),
          replace: z.string().max(MAX_ARTIFACT_BYTES),
        }),
      )
      .min(1)
      .max(MAX_ARTIFACT_EDITS)
      .optional()
      .describe('Find-and-replace edits'),
    title: z.string().trim().min(1).max(MAX_ARTIFACT_TITLE_LENGTH).optional(),
  }),
  available,
  async execute(input, { caller }) {
    const { artifactId, content, edits, title } = input as {
      artifactId: string;
      content?: string;
      edits?: Array<{ find: string; replace: string }>;
      title?: string;
    };
    if ((content === undefined) === (edits === undefined))
      throw validationFailed('Send either `content` or `edits`, not both.');
    const current = await currentContent(artifactId, caller.userId);
    if (!current || current.artifact.threadId !== caller.threadId)
      throw validationFailed('No artifact with that id in this conversation.');
    let next = content;
    if (edits) {
      const applied = applyArtifactEdits(current.content, edits);
      if (!applied.ok) throw validationFailed(applied.error);
      next = applied.content;
    }
    const artifact = await addArtifactVersion({
      artifactId,
      userId: caller.userId,
      role: caller.role,
      threadId: caller.threadId,
      content: next as string,
      source: 'reply',
      messageId: caller.messageId,
      ...(title ? { title } : {}),
    });
    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.currentVersion,
      sizeBytes: artifact.sizeBytes,
    } satisfies ArtifactToolResult;
  },
};

export const ARTIFACT_TOOLS: readonly ToolDefinition[] = [createArtifactTool, updateArtifactTool];

/** For the system prompt: "Report (HTML, version 2)". */
export const describeArtifact = (artifact: {
  title: string;
  kind: ArtifactKind;
  currentVersion: number;
}) =>
  `"${artifact.title}" (${ARTIFACT_KIND_LABELS[artifact.kind]}, version ${artifact.currentVersion})`;
