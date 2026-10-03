import { PROJECT_EXCERPTS_MAX, type ProjectSearchData } from '@oci/shared';
import { singleLine } from '../../lib/text.js';
import { textCost } from '../chat/context-budget.js';
import { passageKey, passageSnippet } from './excerpts.js';
import type { RetrievedChunk } from './retrieval.js';

/** A run of one file's chunks, stitched together where they overlap. */
export interface ProjectPassage {
  attachmentId: string;
  filename: string;
  /** 1-based passage numbers of the first and last chunk in the run. */
  first: number;
  last: number;
  start: number;
  end: number;
  text: string;
  /** How many chunks it was stitched from. */
  chunks: number;
}

/** The model-facing text of a passage: labelled with its file and passage number. */
export function renderPassage(passage: ProjectPassage): string {
  const label =
    passage.first === passage.last
      ? `Passage ${passage.first}`
      : `Passages ${passage.first}–${passage.last}`;
  return `${label} of project file "${singleLine(passage.filename)}":\n\n${passage.text}`;
}

/** What one chunk costs on its own, label included. Stitching only makes it cheaper. */
function chunkCost(chunk: RetrievedChunk): number {
  return textCost(
    renderPassage({
      attachmentId: chunk.attachmentId,
      filename: chunk.filename,
      first: chunk.ordinal + 1,
      last: chunk.ordinal + 1,
      start: chunk.start,
      end: chunk.end,
      text: chunk.content,
      chunks: 1,
    }),
  ).units;
}

/**
 * Takes candidates in the order given (best first) while their cost fits
 * `units`, then orders the chosen chunks by file (in `fileOrder`) and position
 * and stitches overlapping or touching neighbours into one passage, so no text
 * is repeated. Each chunk is costed as if it stood alone, so the stitched
 * result never costs more than `units`.
 */
export function selectPassages(
  candidates: RetrievedChunk[],
  fileOrder: string[],
  units: number,
): ProjectPassage[] {
  const chosen: RetrievedChunk[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const chunk of candidates) {
    const key = `${chunk.attachmentId}:${chunk.ordinal}`;
    if (seen.has(key)) continue;
    const cost = chunkCost(chunk);
    if (used + cost > units) continue;
    seen.add(key);
    used += cost;
    chosen.push(chunk);
  }
  const position = new Map(fileOrder.map((id, index) => [id, index]));
  chosen.sort(
    (a, b) =>
      (position.get(a.attachmentId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.attachmentId) ?? Number.MAX_SAFE_INTEGER) ||
      a.attachmentId.localeCompare(b.attachmentId) ||
      a.ordinal - b.ordinal,
  );
  const passages: ProjectPassage[] = [];
  for (const chunk of chosen) {
    const previous = passages.at(-1);
    if (
      previous &&
      previous.attachmentId === chunk.attachmentId &&
      chunk.ordinal === previous.last &&
      chunk.start <= previous.end &&
      chunk.end > previous.end
    ) {
      previous.text += chunk.content.slice(previous.end - chunk.start);
      previous.end = chunk.end;
      previous.last = chunk.ordinal + 1;
      previous.chunks += 1;
      continue;
    }
    passages.push({
      attachmentId: chunk.attachmentId,
      filename: chunk.filename,
      first: chunk.ordinal + 1,
      last: chunk.ordinal + 1,
      start: chunk.start,
      end: chunk.end,
      text: chunk.content,
      chunks: 1,
    });
  }
  return passages;
}

/**
 * Names and passage counts, in file order, with the start of each passage
 * (v0.10): at most PROJECT_EXCERPTS_MAX passages are listed, the first ones
 * in file order; every passage is still counted. `headings` comes from
 * `passageHeadings` and may be empty.
 */
export function projectSearchSummary(
  passages: ProjectPassage[],
  mode: ProjectSearchData['mode'],
  headings: Map<string, string> = new Map(),
): ProjectSearchData {
  const files = new Map<string, ProjectSearchData['files'][number]>();
  let listed = 0;
  for (const passage of passages) {
    const entry = files.get(passage.attachmentId) ?? {
      name: passage.filename,
      passages: 0,
      excerpts: [],
    };
    entry.passages += passage.chunks;
    if (listed < PROJECT_EXCERPTS_MAX) {
      listed += 1;
      const heading = headings.get(passageKey(passage));
      entry.excerpts!.push({
        id: `${passage.attachmentId}:${passage.first}-${passage.last}`,
        first: passage.first,
        last: passage.last,
        ...(heading && { heading }),
        snippet: passageSnippet(passage.text),
      });
    }
    files.set(passage.attachmentId, entry);
  }
  return { mode, files: [...files.values()] };
}
