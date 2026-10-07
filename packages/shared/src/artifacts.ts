import { z } from 'zod';
import { codeLanguageInfo } from './code-languages.js';

/**
 * Artifacts (v0.9): substantial HTML, SVG, Mermaid and Markdown content kept
 * as a versioned object of its own. This module holds what the server and
 * every renderer must agree on: kinds, limits, which fenced blocks in a reply
 * become artifacts (and their stable keys), and the vetted libraries a frame
 * may ask OCI to inline. See docs/dev/v0.9-design.md, "Artifacts".
 */

/**
 * `code` (#298): program code the person asked to have as an artifact, in its
 * `language`. Never made from a reply's fenced blocks: code in a reply stays
 * a code block.
 */
export const ARTIFACT_KINDS = ['html', 'svg', 'mermaid', 'markdown', 'code'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Largest content of one version, in UTF-8 bytes. Larger content is refused. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_TITLE_LENGTH = 120;
/** Versions one artifact may hold; a further change is refused. */
export const MAX_ARTIFACT_VERSIONS = 100;
/** Artifacts one conversation may hold; further blocks stay ordinary code blocks. */
export const MAX_ARTIFACTS_PER_THREAD = 200;
/** Find-and-replace edits in one `update_artifact` call. */
export const MAX_ARTIFACT_EDITS = 20;
/** Mermaid blocks shorter than this (non-empty lines) stay inline diagrams only. */
export const MIN_MERMAID_LINES = 3;
/** HTML blocks shorter than this (non-empty lines) stay code unless they are whole documents. */
export const MIN_HTML_LINES = 10;

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  html: 'HTML',
  svg: 'SVG',
  mermaid: 'Mermaid',
  markdown: 'Document',
  code: 'Code',
};

/** File extension and MIME type offered for a download. */
export const ARTIFACT_FILE_TYPES: Record<ArtifactKind, { extension: string; mimeType: string }> = {
  html: { extension: 'html', mimeType: 'text/html' },
  svg: { extension: 'svg', mimeType: 'image/svg+xml' },
  mermaid: { extension: 'mmd', mimeType: 'text/plain' },
  markdown: { extension: 'md', mimeType: 'text/markdown' },
  code: { extension: 'txt', mimeType: 'text/plain' },
};

/**
 * An artifact's kind as people read it; a code artifact by its language
 * ("Python"). A kind a later release adds reads "Artifact" here rather than
 * "undefined": during a rolling upgrade this release may meet one (#298).
 */
export function artifactKindLabel(kind: ArtifactKind, language?: string | null): string {
  if (kind === 'code') return codeLanguageInfo(language).label;
  return ARTIFACT_KIND_LABELS[kind] ?? 'Artifact';
}

/**
 * The file type of a download; a code artifact's follows its language
 * (`.py`), and a kind a later release adds is plain text.
 */
export function artifactFileType(
  kind: ArtifactKind,
  language?: string | null,
): { extension: string; mimeType: string } {
  if (kind === 'code')
    return { extension: codeLanguageInfo(language).extension, mimeType: 'text/plain' };
  return ARTIFACT_FILE_TYPES[kind] ?? { extension: 'txt', mimeType: 'text/plain' };
}

/**
 * Libraries a sandboxed frame may use. OCI inlines the code (served from its
 * own bundle) in place of `<script data-oci-library="name"></script>`; the
 * frame itself can never fetch anything. Each was licence-checked when added.
 */
export const ARTIFACT_LIBRARIES = {
  d3: { label: 'D3', version: '7.9.0', license: 'ISC', global: 'd3' },
} as const;
export type ArtifactLibrary = keyof typeof ARTIFACT_LIBRARIES;

/** The marker a frame uses to ask for a library. */
export const ARTIFACT_LIBRARY_PATTERN =
  /<script\b[^>]*\bdata-oci-library\s*=\s*["']?([a-z0-9-]+)["']?[^>]*>\s*<\/script\s*>/gi;

/** Libraries an artifact asks for, known ones only, in first-use order. */
export function requestedLibraries(content: string): ArtifactLibrary[] {
  const found: ArtifactLibrary[] = [];
  for (const match of content.matchAll(ARTIFACT_LIBRARY_PATTERN)) {
    const name = match[1]?.toLowerCase() ?? '';
    if (name in ARTIFACT_LIBRARIES && !found.includes(name as ArtifactLibrary))
      found.push(name as ArtifactLibrary);
  }
  return found;
}

/** UTF-8 length of `content` (lone surrogates count as the 3-byte replacement character). */
export function artifactByteLength(content: string): number {
  let bytes = 0;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < content.length) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** The stable key of a fenced block: its position among all fences of the reply. */
export const blockKey = (fenceIndex: number) => `block:${fenceIndex}`;
/** The stable key of an artifact created by a tool call. */
export const toolKey = (toolCallId: string) => `tool:${toolCallId}`;

export interface FencedBlock {
  /** Position among every fenced block of the text, artifact-worthy or not. */
  fenceIndex: number;
  lang: string;
  content: string;
  /** Offsets of the whole fence (opening line to closing line) in the text. */
  start: number;
  end: number;
}

export interface ArtifactBlock extends FencedBlock {
  key: string;
  kind: Exclude<ArtifactKind, 'markdown' | 'code'>;
  title: string;
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Closed fenced code blocks in Markdown, in order. Only top-level fences (at
 * most three spaces of indentation) are read, as CommonMark does; a fence left
 * open (a reply still streaming) is not returned.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let open: { marker: string; lang: string; start: number; body: string[] } | null = null;
  let fenceIndex = 0;
  for (const line of lines) {
    const lineEnd = offset + line.length;
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(clean);
      if (
        closing?.[1] &&
        closing[1][0] === open.marker[0] &&
        closing[1].length >= open.marker.length
      ) {
        blocks.push({
          fenceIndex: fenceIndex++,
          lang: open.lang,
          content: open.body.join('\n'),
          start: open.start,
          end: lineEnd,
        });
        open = null;
      } else {
        open.body.push(clean);
      }
    } else {
      const opening = OPEN_FENCE.exec(clean);
      const marker = opening?.[1];
      const info = opening?.[2] ?? '';
      // A backtick fence's info string may not contain backticks (CommonMark).
      if (marker && !(marker[0] === '`' && info.includes('`'))) {
        open = {
          marker,
          lang: info.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
          start: offset,
          body: [],
        };
      }
    }
    offset = lineEnd + 1;
  }
  return blocks;
}

const nonEmptyLines = (content: string) => content.split('\n').filter((line) => line.trim()).length;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** A single line of plain text, at most the title length. */
export function cleanArtifactTitle(value: string): string {
  const text = decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ARTIFACT_TITLE_LENGTH
    ? `${text.slice(0, MAX_ARTIFACT_TITLE_LENGTH - 1).trimEnd()}…`
    : text;
}

function firstMatch(content: string, pattern: RegExp): string {
  const match = pattern.exec(content);
  return match?.[1] ? cleanArtifactTitle(match[1]) : '';
}

const MERMAID_TYPES: Array<[RegExp, string]> = [
  [/^(?:flowchart|graph)\b/, 'Flowchart'],
  [/^sequenceDiagram\b/, 'Sequence diagram'],
  [/^classDiagram\b/, 'Class diagram'],
  [/^stateDiagram(?:-v2)?\b/, 'State diagram'],
  [/^erDiagram\b/, 'Entity relationship diagram'],
  [/^gantt\b/, 'Gantt chart'],
  [/^pie\b/, 'Pie chart'],
  [/^mindmap\b/, 'Mind map'],
  [/^timeline\b/, 'Timeline'],
  [/^journey\b/, 'User journey'],
  [/^quadrantChart\b/, 'Quadrant chart'],
  [/^gitGraph\b/, 'Git graph'],
  [/^xychart(?:-beta)?\b/, 'Chart'],
  [/^sankey(?:-beta)?\b/, 'Sankey diagram'],
];

/** A readable title for a detected block: its own title when it has one. */
export function blockTitle(kind: ArtifactBlock['kind'], content: string): string {
  if (kind === 'html') {
    return (
      firstMatch(content, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      firstMatch(content, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
      'HTML page'
    );
  }
  if (kind === 'svg') {
    return (
      firstMatch(content, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      firstMatch(content, /<svg\b[^>]*\baria-label\s*=\s*"([^"]+)"/i) ||
      'SVG image'
    );
  }
  const own =
    firstMatch(content, /^\s*title\s*:\s*(.+)$/m) ||
    firstMatch(content, /^\s*(?:pie\s+(?:showData\s+)?)?title\s+(.+)$/m);
  if (own) return own;
  const body = content
    .replace(/^---[\s\S]*?---\s*/, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('%%'));
  return MERMAID_TYPES.find(([pattern]) => pattern.test(body ?? ''))?.[1] ?? 'Diagram';
}

/** The artifact kind of a fenced block, or null when it stays an ordinary code block. */
export function blockKind(
  block: Pick<FencedBlock, 'lang' | 'content'>,
): ArtifactBlock['kind'] | null {
  const content = block.content.trim();
  if (!content || artifactByteLength(block.content) > MAX_ARTIFACT_BYTES) return null;
  const wholeSvg = /^(?:<\?xml[^>]*>\s*)?<svg\b[\s\S]*<\/svg>$/i.test(content);
  if (block.lang === 'svg') return /<svg\b/i.test(content) ? 'svg' : null;
  if (block.lang === 'mermaid')
    return nonEmptyLines(content) >= MIN_MERMAID_LINES ? 'mermaid' : null;
  if (block.lang === 'html' || block.lang === 'htm') {
    if (wholeSvg) return 'svg';
    const document = /<!doctype html|<html[\s>]|<body[\s>]/i.test(content);
    return document || nonEmptyLines(content) >= MIN_HTML_LINES ? 'html' : null;
  }
  if (block.lang === 'xml' || block.lang === '') return wholeSvg ? 'svg' : null;
  return null;
}

/**
 * The blocks of a finished reply that become artifacts: HTML and SVG code
 * blocks and Mermaid diagrams of at least a few lines. Ordinary code blocks
 * stay code blocks. Keys are positions among all fences, so detection can be
 * repeated (a retry of persistence, a continued reply) and lands on the same
 * artifacts.
 */
export function detectArtifactBlocks(text: string): ArtifactBlock[] {
  return fencedBlocks(text).flatMap((block) => {
    const kind = blockKind(block);
    if (!kind) return [];
    return [
      { ...block, key: blockKey(block.fenceIndex), kind, title: blockTitle(kind, block.content) },
    ];
  });
}

export type ReplySegment =
  | { type: 'markdown'; text: string }
  | { type: 'artifact'; block: ArtifactBlock; raw: string };

/** A reply's text split around artifact blocks, for renderers that show a card in their place. */
export function splitArtifactSegments(text: string): ReplySegment[] {
  const blocks = detectArtifactBlocks(text);
  if (blocks.length === 0) return [{ type: 'markdown', text }];
  const segments: ReplySegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const before = text.slice(cursor, block.start);
    if (before.trim()) segments.push({ type: 'markdown', text: before });
    segments.push({ type: 'artifact', block, raw: text.slice(block.start, block.end) });
    cursor = block.end + 1;
  }
  const after = text.slice(cursor);
  if (after.trim()) segments.push({ type: 'markdown', text: after });
  return segments;
}

/** One find-and-replace edit of `update_artifact`. */
export interface ArtifactEdit {
  find: string;
  replace: string;
}

/**
 * Applies edits in order. Each `find` must occur exactly once in the content
 * as it is when that edit runs, so an edit never lands somewhere unintended.
 * Returns the new content or a message the model can act on.
 */
export function applyArtifactEdits(
  content: string,
  edits: readonly ArtifactEdit[],
): { ok: true; content: string } | { ok: false; error: string } {
  let next = content;
  for (const [index, edit] of edits.entries()) {
    if (!edit.find) return { ok: false, error: `Edit ${index + 1}: "find" is empty.` };
    const first = next.indexOf(edit.find);
    if (first === -1)
      return { ok: false, error: `Edit ${index + 1}: the text to find was not found.` };
    if (next.indexOf(edit.find, first + 1) !== -1)
      return {
        ok: false,
        error: `Edit ${index + 1}: the text to find occurs more than once; include more context.`,
      };
    next = next.slice(0, first) + edit.replace + next.slice(first + edit.find.length);
  }
  return { ok: true, content: next };
}

export const ARTIFACT_VERSION_SOURCES = ['reply', 'person'] as const;
export type ArtifactVersionSource = (typeof ARTIFACT_VERSION_SOURCES)[number];

export const artifactSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** The reply that created it. */
  messageId: z.string(),
  /** `block:<n>` for a detected block, `tool:<call id>` for one a tool created. */
  sourceKey: z.string(),
  title: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  /** A code artifact's language (`python`); null for the other kinds (#298). */
  language: z.string().nullable(),
  currentVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactVersionSchema = z.object({
  version: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  source: z.enum(ARTIFACT_VERSION_SOURCES),
  messageId: z.string().nullable(),
  createdAt: z.string(),
});
export type ArtifactVersionSummary = z.infer<typeof artifactVersionSchema>;

/** `GET /api/artifacts/:id`: the artifact, its versions (newest first) and current content. */
export interface ArtifactDetail {
  artifact: ArtifactSummary;
  versions: ArtifactVersionSummary[];
  content: string;
}

/** `GET /api/artifacts/:id/versions/:version`. */
export interface ArtifactVersionDetail extends ArtifactVersionSummary {
  content: string;
}

/** Body of `POST /api/artifacts/:id/versions`: a person's edit of a Markdown document. */
export const createArtifactVersionSchema = z
  .object({
    content: z.string().min(1, 'The document is empty.'),
    /** The version the edit started from; a newer one makes the save fail (409). */
    baseVersion: z.number().int().positive(),
  })
  .strict();
export type CreateArtifactVersionInput = z.infer<typeof createArtifactVersionSchema>;

/** An artifact as a public share link carries it: one version's content, credentials redacted. */
export interface PublicArtifact {
  messageId: string;
  sourceKey: string;
  title: string;
  kind: ArtifactKind;
  /** A code artifact's language; null for the other kinds (#298). */
  language: string | null;
  version: number;
  content: string;
}
