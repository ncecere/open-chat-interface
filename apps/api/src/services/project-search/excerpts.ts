import { schema, sql } from '@oci/db';
import { PROJECT_EXCERPT_MAX_CHARS } from '@oci/shared';
import { db } from '../../db/index.js';
import { stripControls } from '../../lib/text.js';
import type { ProjectPassage } from './passages.js';
import { textArray } from './retrieval.js';

/**
 * What a reply's project-search note shows of each passage (v0.10): the first
 * PROJECT_EXCERPT_MAX_CHARS characters and, when it can be told, the heading
 * of the section the passage starts in.
 *
 * Headings are not stored when files are indexed, so they are read here from
 * the file's extracted text: the first Markdown-style heading line (`# Title`
 * to `###### Title`) inside the passage, as the section most of it is about,
 * else the last one in the text just before it. Files without such lines (most
 * PDFs and Word documents, whose extraction keeps no heading marks) get none.
 */

/** How much text before a passage is read to find the heading it falls under. */
const HEADING_LOOKBACK_CHARS = 4000;
const HEADING_MAX_CHARS = 120;
const HEADING_LINE = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm;

function cleanHeading(value: string): string | null {
  const text = stripControls(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > HEADING_MAX_CHARS ? `${text.slice(0, HEADING_MAX_CHARS - 1)}…` : text;
}

function headingLines(text: string): Array<{ index: number; title: string }> {
  const found: Array<{ index: number; title: string }> = [];
  HEADING_LINE.lastIndex = 0;
  for (let match = HEADING_LINE.exec(text); match; match = HEADING_LINE.exec(text)) {
    found.push({ index: match.index, title: match[1]! });
  }
  return found;
}

/**
 * The heading a passage falls under, from the text before it and its own
 * text, or null when neither has a heading line. Exported for tests.
 */
export function passageHeading(before: string, text: string): string | null {
  const own = headingLines(text)[0];
  if (own) return cleanHeading(own.title);
  const previous = headingLines(before).at(-1);
  return previous ? cleanHeading(previous.title) : null;
}

/**
 * The start of a passage as one line, without a heading line that opens it,
 * clipped to PROJECT_EXCERPT_MAX_CHARS with an ellipsis. Exported for tests.
 */
export function passageSnippet(text: string): string {
  let body = text;
  const opening = headingLines(text)[0];
  if (opening && text.slice(0, opening.index).trim() === '') {
    const lineEnd = text.indexOf('\n', opening.index);
    body = lineEnd < 0 ? '' : text.slice(lineEnd + 1);
  }
  const line = stripControls(body).replace(/\s+/g, ' ').trim() || stripControls(text).trim();
  const chars = [...line];
  return chars.length > PROJECT_EXCERPT_MAX_CHARS
    ? `${chars.slice(0, PROJECT_EXCERPT_MAX_CHARS).join('').trimEnd()}…`
    : line;
}

export const passageKey = (passage: Pick<ProjectPassage, 'attachmentId' | 'start'>) =>
  `${passage.attachmentId}:${passage.start}`;

/**
 * The heading of each passage, keyed by `passageKey`. One query reads at most
 * HEADING_LOOKBACK_CHARS of the person's own file text before each passage
 * (PostgreSQL counts characters where offsets count UTF-16 units, so text
 * with characters outside the Basic Multilingual Plane may shift the window
 * slightly; only the heading can be affected). A failure only means no
 * headings, never a failed reply.
 */
export async function passageHeadings(
  passages: ProjectPassage[],
  userId: string,
): Promise<Map<string, string>> {
  const headings = new Map<string, string>();
  if (passages.length === 0) return headings;
  let rows: Array<{ ordinal: number; before: string | null }> = [];
  try {
    const starts = sql`array[${sql.join(
      passages.map((passage) => sql`${Math.max(0, Math.trunc(passage.start))}`),
      sql`, `,
    )}]::int[]`;
    rows = await db.execute<{ ordinal: number; before: string | null }>(sql`
      select p.ordinal::int as ordinal,
             substring(a.extracted_text
                       from greatest(p.start - ${HEADING_LOOKBACK_CHARS}, 0) + 1
                       for p.start - greatest(p.start - ${HEADING_LOOKBACK_CHARS}, 0)) as before
      from unnest(${textArray(passages.map((passage) => passage.attachmentId))}, ${starts})
             with ordinality as p(id, start, ordinal)
      join ${schema.attachment} a on a.id = p.id and a.user_id = ${userId}
    `);
  } catch {
    return headings;
  }
  const before = new Map(rows.map((row) => [Number(row.ordinal) - 1, row.before ?? '']));
  passages.forEach((passage, index) => {
    const text = before.get(index) ?? '';
    // The lookback may begin mid-line; a partial first line is not a heading.
    const whole = passage.start > HEADING_LOOKBACK_CHARS ? text.replace(/^[^\n]*\n?/, '') : text;
    const heading = passageHeading(whole, passage.text);
    if (heading) headings.set(passageKey(passage), heading);
  });
  return headings;
}
