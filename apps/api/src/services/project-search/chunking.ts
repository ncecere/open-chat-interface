/**
 * Splits a project file's extracted text into overlapping chunks for keyword
 * search (see docs/dev/tools-design.md, "Large project files").
 *
 * Chunks aim for `targetChars` characters and break on the strongest boundary
 * available in their second half: a blank line (paragraph), then the end of a
 * sentence, then a line break, then a space. Consecutive chunks overlap by up
 * to `overlapChars`, starting at a sentence or word boundary, so a passage cut
 * at a boundary is still found whole in one of them.
 *
 * Offsets are JavaScript string indices (UTF-16 code units) into the extracted
 * text, and `content === text.slice(start, end)` always holds, so overlapping
 * neighbours can be stitched back together exactly. A surrogate pair is never
 * split.
 */

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 200;
/** Far above what extraction produces today (200,000 characters, ~200 chunks). */
export const MAX_CHUNKS_PER_FILE = 2000;

export interface TextChunk {
  ordinal: number;
  start: number;
  end: number;
  content: string;
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*\s/g;
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/g;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Moves an index forward past whitespace. */
function skipWhitespace(text: string, index: number): number {
  let position = index;
  while (position < text.length && /\s/.test(text[position]!)) position += 1;
  return position;
}

/** Moves an end index back past whitespace, never before `floor`. */
function trimEnd(text: string, end: number, floor: number): number {
  let position = end;
  while (position > floor && /\s/.test(text[position - 1]!)) position -= 1;
  return position;
}

/** The end of the last match of `pattern` within [from, to), or -1. */
function lastBoundary(text: string, pattern: RegExp, from: number, to: number): number {
  const window = text.slice(from, to);
  let found = -1;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(window); match; match = pattern.exec(window)) {
    found = from + match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return found;
}

/** Where a chunk starting at `start` should end. */
function chunkEnd(text: string, start: number, target: number): number {
  const limit = start + target;
  if (limit >= text.length) return text.length;
  const floor = start + Math.floor(target / 2);
  for (const pattern of [PARAGRAPH_BREAK, SENTENCE_END]) {
    const boundary = lastBoundary(text, pattern, floor, limit);
    if (boundary > floor) return boundary;
  }
  const newline = text.lastIndexOf('\n', limit - 1);
  if (newline >= floor) return newline + 1;
  const space = text.slice(floor, limit).search(/\s\S*$/);
  if (space >= 0) return floor + space + 1;
  // No boundary at all (one very long word): cut, keeping surrogate pairs whole.
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/** Where the next chunk starts: inside the overlap, at a sentence or word start. */
function nextStart(text: string, start: number, end: number, overlap: number): number {
  if (overlap <= 0) return skipWhitespace(text, end);
  const from = Math.max(start + 1, end - overlap);
  const window = text.slice(from, end);
  SENTENCE_END.lastIndex = 0;
  const sentence = SENTENCE_END.exec(window);
  if (sentence) return skipWhitespace(text, from + sentence.index + sentence[0].length);
  const space = window.search(/\s/);
  if (space >= 0) return skipWhitespace(text, from + space);
  return skipWhitespace(text, end);
}

/**
 * Chunks `text`. Returns no chunks for empty or whitespace-only text, and
 * `truncated: true` when the text needed more than `maxChunks` chunks (the
 * rest is then not searchable).
 */
export function chunkText(
  text: string,
  options: ChunkOptions = {},
): { chunks: TextChunk[]; truncated: boolean } {
  const target = Math.max(2, Math.floor(options.targetChars ?? CHUNK_TARGET_CHARS));
  const overlap = Math.max(
    0,
    Math.min(Math.floor(options.overlapChars ?? CHUNK_OVERLAP_CHARS), Math.floor(target / 4)),
  );
  const maxChunks = Math.max(0, Math.floor(options.maxChunks ?? MAX_CHUNKS_PER_FILE));
  const chunks: TextChunk[] = [];
  let start = skipWhitespace(text, 0);
  while (start < text.length) {
    if (chunks.length >= maxChunks) return { chunks, truncated: true };
    const rawEnd = chunkEnd(text, start, target);
    const end = trimEnd(text, rawEnd, start + 1);
    chunks.push({ ordinal: chunks.length, start, end, content: text.slice(start, end) });
    if (rawEnd >= text.length) break;
    const following = nextStart(text, start, end, overlap);
    // Always make progress, whatever the boundaries looked like.
    start = following > start ? following : skipWhitespace(text, rawEnd);
  }
  return { chunks, truncated: false };
}
