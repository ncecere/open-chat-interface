import {
  ARTIFACT_KINDS,
  ARTIFACT_NOT_SAVED,
  type ArtifactKind,
  applyArtifactEdits,
  artifactKindLabel,
  type DeclinedArtifactResult,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_EDITS,
  MAX_ARTIFACT_TITLE_LENGTH,
  MAX_CODE_LANGUAGE_LENGTH,
  markdownArtifactRefusal,
  toolKey,
} from '@oci/shared';
import { z } from 'zod';
import { validationFailed } from '../../lib/errors.js';
import { codeArtifactsReady } from '../artifacts/code-kind.js';
import { personAskedForArtifact } from '../artifacts/markdown-floor.js';
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
  /** A code artifact's language (#298). */
  language?: string | null;
  version: number;
  sizeBytes: number;
}

/** Code nobody asked to have as an artifact stays in the reply (#149, #298). */
export const CODE_ARTIFACT_REFUSAL = `${ARTIFACT_NOT_SAVED}: program code belongs in fenced code blocks in your reply unless the person asks for an artifact. Write it in your reply once (do not repeat it if you already have).`;

/** Before every replica reads code artifacts (see code-kind.ts), code stays in the reply. */
export const CODE_ARTIFACT_NOT_YET = `${ARTIFACT_NOT_SAVED}: code cannot be saved as an artifact here yet. Write it in a fenced code block in your reply once, and say that code is not saved as an artifact.`;

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
  // "Say ... what it holds": a reply of only "Done!" left the person nothing to read or copy (#313).
  description: [
    'Save content the person will want to see rendered as an artifact they can open, preview, copy and download:',
    'an HTML page or small app (a complete, self-contained document), an SVG image or diagram,',
    'a Mermaid diagram, or a long prose document they asked for (a report, letter or plan) as Markdown.',
    'Program code goes in fenced code blocks in your reply, one per language or file, unless the person asks for it as an artifact:',
    'then save it as kind code with its language (for example python), the code alone, never wrapped in an HTML page.',
    'Never use it for tables, lists or short answers: write those in your reply.',
    'Do not repeat the content in your reply or link to it; a card appears on its own. Say in your reply, in a sentence or two, what it holds. Returns the artifact id for later updates.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(MAX_ARTIFACT_TITLE_LENGTH).describe('A short title'),
    kind: z.enum(ARTIFACT_KINDS).describe('html, svg, mermaid, markdown or code'),
    language: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CODE_LANGUAGE_LENGTH)
      .optional()
      .describe('For kind code: the programming language, such as python, javascript or bash'),
    content: contentSchema.describe('The full content'),
  }),
  available,
  async execute(input, { caller, toolCallId }) {
    const { title, kind, language, content } = input as {
      title: string;
      kind: ArtifactKind;
      language?: string;
      content: string;
    };
    // Code becomes an artifact only when the person asked for one (#298);
    // otherwise it stays in the reply, as the guidance says (#149).
    if (kind === 'code') {
      if (!(await codeArtifactsReady()))
        return { saved: false, note: CODE_ARTIFACT_NOT_YET } satisfies DeclinedArtifactResult;
      if (!(await personAskedForArtifact(caller.threadId)))
        return { saved: false, note: CODE_ARTIFACT_REFUSAL } satisfies DeclinedArtifactResult;
    }
    // The guidance alone did not stop small tables and functions becoming
    // Markdown artifacts (#149); see markdownArtifactRefusal in @oci/shared.
    // Declined as a result, not thrown as an error (#201): nothing failed,
    // and a failed step showed the person "3 steps failed" and this note to
    // the model word for word. The conversation leaves such a call out.
    if (kind === 'markdown') {
      const refusal = markdownArtifactRefusal(content);
      if (refusal && !(await personAskedForArtifact(caller.threadId)))
        return { saved: false, note: refusal } satisfies DeclinedArtifactResult;
    }
    const { artifact } = await createArtifact({
      userId: caller.userId,
      role: caller.role,
      threadId: caller.threadId,
      messageId: caller.messageId,
      sourceKey: toolKey(toolCallId ?? crypto.randomUUID()),
      title,
      kind,
      language,
      content,
    });
    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      language: artifact.language,
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
      language: artifact.language,
      version: artifact.currentVersion,
      sizeBytes: artifact.sizeBytes,
    } satisfies ArtifactToolResult;
  },
};

export const ARTIFACT_TOOLS: readonly ToolDefinition[] = [createArtifactTool, updateArtifactTool];

/** For the system prompt: "Report (HTML, version 2)", "Inventory script (Python, version 1)". */
export const describeArtifact = (artifact: {
  title: string;
  kind: ArtifactKind;
  language?: string | null;
  currentVersion: number;
}) =>
  `"${artifact.title}" (${artifactKindLabel(artifact.kind, artifact.language)}, version ${artifact.currentVersion})`;
