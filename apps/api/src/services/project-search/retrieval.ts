import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { stripControls, tsqueryOperand } from '../../lib/text.js';
import {
  KEYWORD_DISTINCTIVE_MAX_SHARE,
  KEYWORD_DISTINCTIVE_MIN_CHUNKS,
  nearBest,
} from './relevance.js';

/**
 * Keyword retrieval over one project's file chunks.
 *
 * The message is split into words by PostgreSQL's own parser with the same
 * 'simple' configuration the chunks are indexed with; the raw text is only ever
 * a bound parameter, so operators and punctuation in it are never interpreted.
 * Unlike conversation search (every word must match), any word may match here
 * and passages are ranked by how many of the words they contain, how often,
 * and how rare each word is in the project's files: a word found in nearly
 * every passage (such as "the") counts for little.
 *
 * Since v0.9 a passage must also be relevant enough to be used at all (see
 * relevance.ts): it must contain at least one distinctive word of the message,
 * and score close enough to the best passage. A message that shares only
 * common words with the files finds nothing.
 */

/** Only the start of a long message is searched; the rest rarely helps ranking. */
const QUERY_MAX_CHARS = 2000;
const MAX_TERMS = 32;
/** Longer words are matched as prefixes ("plan" finds "planning"); shorter ones exactly. */
const PREFIX_MIN_CHARS = 4;
const MAX_LEXEME_CHARS = 100;

export interface RetrievedChunk {
  attachmentId: string;
  filename: string;
  ordinal: number;
  start: number;
  end: number;
  content: string;
}

/** A bound text[] literal: one parameter per element, never spliced as SQL. */
export function textArray(values: string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** One searchable word of a message. */
export interface SearchTerm {
  /** A single-term tsquery operand, such as `'kestrel':*`. */
  operand: string;
  /**
   * An English stop word ("what", "about", "is"), by PostgreSQL's own list.
   * It still counts towards a passage's score but never qualifies a passage
   * on its own, even in files where it happens to be rare.
   */
  stopWord: boolean;
}

/**
 * The searchable words of a message, in the order they first appear. Empty
 * when nothing searchable is left.
 */
export async function projectSearchTerms(raw: string): Promise<SearchTerm[]> {
  const text = stripControls(raw.normalize('NFC').slice(0, QUERY_MAX_CHARS)).trim();
  if (!text) return [];
  // The 'english_stem' dictionary returns an empty array for a stop word.
  const rows = await db.execute<{ lexeme: string; stop_word: boolean }>(sql`
    select lexeme,
           coalesce(cardinality(ts_lexize('english_stem'::regdictionary, lexeme)) = 0, false)
             as stop_word
    from unnest(to_tsvector('simple'::regconfig, ${text})) as words(lexeme, positions, weights)
    order by positions[1]
  `);
  return rows
    .filter(({ lexeme }) => {
      const length = [...lexeme].length;
      // A lone letter (from "it's", or an initial) matches too much to help.
      return length > 1 && length <= MAX_LEXEME_CHARS;
    })
    .slice(0, MAX_TERMS)
    .map(({ lexeme, stop_word }) => ({
      operand: tsqueryOperand(lexeme, [...lexeme].length >= PREFIX_MIN_CHARS),
      stopWord: stop_word === true,
    }));
}

/**
 * Restricts chunks to the given files of this person's project. The file ids
 * already come from an owner- and project-scoped query; checking again here
 * keeps another person's or another project's chunks out even if they did not.
 */
export function scopedChunks(scope: { userId: string; projectId: string; fileIds: string[] }) {
  return sql`
    select c.attachment_id, c.ordinal, c.start_offset, c.end_offset, c.content, c.search,
           a.filename
    from project_file_chunk c
    join attachment a on a.id = c.attachment_id
    where c.attachment_id = any(${textArray(scope.fileIds)})
      and a.user_id = ${scope.userId}
      and a.project_id = ${scope.projectId}
      and a.upload_pending = false
      and a.deleted_at is null
  `;
}

export type ChunkRow = {
  attachment_id: string;
  filename: string;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  content: string;
};

export function toChunk(row: ChunkRow): RetrievedChunk {
  return {
    attachmentId: row.attachment_id,
    filename: row.filename,
    ordinal: Number(row.ordinal),
    start: Number(row.start_offset),
    end: Number(row.end_offset),
    content: row.content,
  };
}

/**
 * The relevant chunks, best first. Each word is its own tsquery: a chunk
 * scores the sum, over the words it contains, of the word's rarity among the
 * project's chunks (BM25's inverse document frequency) times a saturating
 * function of its `ts_rank_cd` for that word.
 *
 * Only chunks containing at least one distinctive word (in at most
 * `KEYWORD_DISTINCTIVE_MAX_SHARE` of the project's chunks, or
 * `KEYWORD_DISTINCTIVE_MIN_CHUNKS`, and not a stop word) qualify, and of
 * those only the ones scoring at least `KEYWORD_RELATIVE_FLOOR` of the best
 * (see relevance.ts).
 */
export async function rankProjectChunks(
  scope: { userId: string; projectId: string; fileIds: string[] },
  terms: SearchTerm[],
  limit: number,
): Promise<RetrievedChunk[]> {
  if (terms.length === 0 || scope.fileIds.length === 0 || limit <= 0) return [];
  const operands = terms.map((term) => term.operand);
  const stopWords = terms.filter((term) => term.stopWord).map((term) => term.operand);
  const rows = await db.execute<ChunkRow & { score: number }>(sql`
    with scope as materialized (${scopedChunks(scope)}),
    total as (select count(*)::float8 as n from scope),
    terms as (
      select operand, operand::tsquery as query,
             operand = any(${textArray(stopWords)}) as stop_word
      from unnest(${textArray(operands)}) as given(operand)
    ),
    hits as materialized (
      select s.attachment_id, s.ordinal, t.operand, t.stop_word,
             ts_rank_cd(s.search, t.query) as rank
      from scope s
      cross join terms t
      where s.search @@ t.query
    ),
    rarity as (
      select h.operand,
             ln(1 + (total.n - count(*) + 0.5) / (count(*) + 0.5)) as idf,
             count(*) <= greatest(${KEYWORD_DISTINCTIVE_MIN_CHUNKS}::float8,
                                  total.n * ${KEYWORD_DISTINCTIVE_MAX_SHARE}::float8)
               and not bool_or(h.stop_word) as distinctive
      from hits h
      cross join total
      group by h.operand, total.n
    ),
    scored as (
      select h.attachment_id, h.ordinal, sum(r.idf * h.rank / (h.rank + 0.2)) as score
      from hits h
      join rarity r on r.operand = h.operand
      group by h.attachment_id, h.ordinal
      having bool_or(r.distinctive)
    )
    select s.attachment_id, s.filename, s.ordinal, s.start_offset, s.end_offset, s.content,
           scored.score::float8 as score
    from scored
    join scope s on s.attachment_id = scored.attachment_id and s.ordinal = scored.ordinal
    order by scored.score desc, s.attachment_id, s.ordinal
    limit ${limit}
  `);
  // Sorted best first, so the cut relative to the best is the same before or
  // after the limit.
  return nearBest(rows.map((row) => ({ ...row, score: Number(row.score) }))).map(toChunk);
}

/** Chunk counts of the given files that have been indexed; unindexed files are absent. */
export async function indexedChunkCounts(fileIds: string[]): Promise<Map<string, number>> {
  if (fileIds.length === 0) return new Map();
  const rows = await db.execute<{ attachment_id: string; chunk_count: number }>(sql`
    select attachment_id, chunk_count
    from project_file_index
    where attachment_id = any(${textArray(fileIds)})
  `);
  return new Map(rows.map((row) => [row.attachment_id, Number(row.chunk_count)]));
}
