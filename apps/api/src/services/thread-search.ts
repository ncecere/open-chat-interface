import { and, eq, inArray, isNull, MESSAGE_SEARCH_FOLDED, schema, sql } from '@oci/db';
import {
  plainTextOfMarkdown,
  SEARCH_HIGHLIGHT_END,
  SEARCH_HIGHLIGHT_START,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
} from '@oci/shared';
import { db } from '../db/index.js';
import { foldSql } from '../lib/fold.js';
import { containsPattern } from '../lib/like.js';
import { stripControls, tsqueryOperand } from '../lib/text.js';
import { isBackgroundMigrationDone, isPostStepDone } from './migrations/readiness.js';
import { textArray } from './project-search/retrieval.js';

type SQL = ReturnType<typeof sql.raw>;

/** Longer input is cut, not refused: a pasted paragraph still searches its opening words. */
const SEARCH_QUERY_MAX_CHARS = 200;
/** More terms only narrow an AND query further and make it slower. */
const MAX_TERMS = 12;
const MATCHES_PER_THREAD = 3;
/** ts_headline reads the whole document; very long replies are cut first. */
const SNIPPET_SOURCE_MAX_CHARS = 50_000;

const JSON_TEXT_PATH = `'$[*] ? (@.type == "text").text'::jsonpath`;

/**
 * The searchable document of a message: its `text` parts only, so reasoning,
 * sources, grounding and attachment metadata never match.
 *
 * This must stay character-for-character the expression indexed by migration
 * 0023 (`message_text_search_idx`). It is spliced in as raw SQL because the
 * planner only uses an expression index when the query contains the same
 * constants; bound parameters would not match.
 */
export function messageSearchVector(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('Invalid table alias');
  return sql.raw(
    `to_tsvector('simple'::regconfig, jsonb_path_query_array("${alias}"."parts", ${JSON_TEXT_PATH}))`,
  );
}

/**
 * Accent-insensitive search of message text (#362, SPEC-accent-search.md).
 * `message.search_folded` holds the folded search vector of every message
 * whose text has letters the fold changes (NULL for the rest), kept by a
 * trigger. Search matches the exact-text index OR the partial index over that
 * column, so "bibliotheque" finds "bibliothèque" and the reverse.
 *
 * It is used only once the column is filled for messages written before
 * v0.13 (the background migration) and its index is built (post-deploy step
 * 0014); until both are done, message text is searched exactly as v0.12 did.
 * Titles are folded in the query either way, since nothing indexes them.
 */
export const FOLDED_SEARCH_STEP = '0014_message_search_folded_index';

/**
 * True when message text may be searched ignoring accents: the stored vectors
 * are complete and their index exists. A database that cannot answer reads as
 * not ready (the safe direction), and the answers are cached by
 * `readiness.ts` (permanent once true, 30 seconds while false). Never call it
 * from inside a transaction.
 */
export async function foldedSearchReady(): Promise<boolean> {
  return (
    (await isBackgroundMigrationDone(MESSAGE_SEARCH_FOLDED)) &&
    (await isPostStepDone(FOLDED_SEARCH_STEP))
  );
}

/**
 * The condition a message must meet for a search (`query` is a tsquery). A
 * message with nothing to fold has no stored vector and is the exact index's;
 * one with accents has both, and the stored one holds every word, so matching
 * either finds everything the exact index alone found, and more. Exported so a
 * test can EXPLAIN exactly the predicate that runs.
 */
export function messageSearchCondition(alias: string, query: SQL, folded: boolean): SQL {
  const exact = messageSearchVector(alias);
  if (!folded) return sql`${exact} @@ ${query}`;
  return sql`(${exact} @@ ${query} or ${sql.raw(`"${alias}"."search_folded"`)} @@ ${query})`;
}

/** The same text parts as one string, for snippets. Not indexed, so its form is free. */
function messageSearchText(alias: string): SQL {
  return sql.raw(
    `(select string_agg(part #>> '{}', E'\\n') from jsonb_array_elements(jsonb_path_query_array("${alias}"."parts", ${JSON_TEXT_PATH})) as texts(part) where jsonb_typeof(part) = 'string')`,
  );
}

/**
 * Turns free text into a prefix query: every word must appear, each matched as
 * a prefix (`plan` finds "planning"). The words are split by Postgres's own
 * parser with the same configuration as the index, so e-mail addresses,
 * hyphenated words and numbers tokenise exactly as they do in messages.
 * Operators and punctuation are never interpreted: the raw text is only ever a
 * bound parameter to `to_tsvector`. Returns null when nothing searchable is left.
 */
async function parseSearchQuery(raw: string, folded: boolean): Promise<ParsedQuery | null> {
  const text = stripControls(raw.normalize('NFC').slice(0, SEARCH_QUERY_MAX_CHARS)).trim();
  if (!text) return null;

  // Titles are always folded, and the words that meet them are folded the same
  // way (#362). Message text is folded only once its stored vectors and their
  // index are ready, and its words then meet them as they are held.
  const titleWords = await wordsOf(foldSql(sql`${text}::text`));
  const bodyWords = folded ? titleWords : await wordsOf(sql`${text}`);
  if (titleWords.length === 0 && bodyWords.length === 0) return null;

  const operands = (words: string[]) =>
    words.map((lexeme) => tsqueryOperand(lexeme, true)).join(' & ');
  return {
    tsquery: operands(bodyWords),
    terms: bodyWords,
    folded,
    titleTsquery: operands(titleWords),
    titleTerms: titleWords,
  };
}

/** The words of a search text as Postgres's own parser reads them, in order. */
async function wordsOf(subject: SQL): Promise<string[]> {
  const rows = await db.execute<{ lexeme: string }>(sql`
    select lexeme
    from unnest(to_tsvector('simple'::regconfig, ${subject})) as words(lexeme, positions, weights)
    order by positions[1]
  `);
  const lexemes = rows.map((row) => row.lexeme).filter(Boolean);
  // A lone letter left over from "it's" matches nearly everything as a prefix.
  const longer = lexemes.filter((lexeme) => [...lexeme].length > 1);
  return (longer.length > 0 ? longer : lexemes).slice(0, MAX_TERMS);
}

/** A search as the database runs it. */
export interface ParsedQuery {
  /** Matches message text. */
  tsquery: string;
  /** The words, each matched as a prefix; folded when `folded`. */
  terms: string[];
  /** Whether message text ignores accents: the stored folded vectors are ready (#362). */
  folded: boolean;
  /** As `tsquery` and `terms`, for titles, which always ignore accents (#362). */
  titleTsquery: string;
  titleTerms: string[];
}

/** SQL escape strings for one backslash and two (for quoting a lexeme). */
const ONE_BACKSLASH = sql.raw(String.raw`E'\\'`);
const TWO_BACKSLASHES = sql.raw(String.raw`E'\\\\'`);

/**
 * The query ts_headline highlights with. ts_headline reads the document's own
 * words, so a folded search word would never match "bibliothèque" in it: the
 * query is made from the document's words whose folded form starts with a
 * search word, each quoted as one exact lexeme. Without folding it is the
 * search query itself.
 */
function headlineQuery(folded: boolean, terms: string[], body: SQL, query: SQL): SQL {
  if (!folded) return query;
  return sql`coalesce((
    select string_agg(
      '''' || replace(replace(matched.lexeme, ${ONE_BACKSLASH}, ${TWO_BACKSLASHES}), '''', '''''') || '''',
      ' | '
    )::tsquery
    from (
      select words.lexeme
      from unnest(to_tsvector('simple'::regconfig, ${body})) as words(lexeme, positions, weights)
      where exists (
        select 1 from unnest(${textArray(terms)}) as wanted(term)
        where starts_with(${foldSql('words.lexeme')}, wanted.term)
      )
      limit 100
    ) matched
  ), ${query})`;
}

const SNIPPET_OPTIONS = [
  `StartSel=${SEARCH_HIGHLIGHT_START}`,
  `StopSel=${SEARCH_HIGHLIGHT_END}`,
  'MaxFragments=2',
  'MaxWords=16',
  'MinWords=6',
  'ShortWord=2',
  'FragmentDelimiter=" … "',
].join(', ');

const TITLE_OPTIONS = [
  `StartSel=${SEARCH_HIGHLIGHT_START}`,
  `StopSel=${SEARCH_HIGHLIGHT_END}`,
  'HighlightAll=true',
].join(', ');

function clampSearchLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return THREAD_SEARCH_DEFAULT_LIMIT;
  return Math.min(THREAD_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The ranked search over one person's conversations. Exported so tests can
 * EXPLAIN exactly what runs. Titles always ignore accents (#362). Message text
 * does only with `search.folded`, which callers set from `foldedSearchReady()`:
 * it then matches the exact index or the folded one.
 */
export function threadSearchStatement(
  userId: string,
  search: ParsedQuery,
  rawQuery: string,
  limit: number,
) {
  const query = sql`${search.tsquery}::tsquery`;
  const titleQuery = sql`${search.titleTsquery}::tsquery`;
  const exactVector = messageSearchVector('m');
  const messageMatches = messageSearchCondition('m', query, search.folded);
  const messageRank = search.folded
    ? sql`ts_rank(coalesce(m.search_folded, ${exactVector}), ${query})`
    : sql`ts_rank(${exactVector}, ${query})`;
  const titleText = foldSql('t.title');
  const titleVector = sql`to_tsvector('simple'::regconfig, ${titleText})`;
  const typed = containsPattern(stripControls(rawQuery).trim().slice(0, SEARCH_QUERY_MAX_CHARS));
  const pattern = foldSql(sql`${typed}::text`);
  const titleLike = sql`${titleText} ilike ${pattern} escape '\\'`;
  const titleMatches = sql`(${titleVector} @@ ${titleQuery} or ${titleLike})`;
  const titleBody = sql`translate(t.title, chr(1) || chr(2), '  ')`;
  const messageBody = sql`translate(left(${messageSearchText('m')}, ${SNIPPET_SOURCE_MAX_CHARS}), chr(1) || chr(2), '  ')`;

  return sql`
    with hits as materialized (
      select m.id, m.thread_id, m.role, m.position, ${messageRank} as rank
      from message m
      join thread t on t.id = m.thread_id
      where t.user_id = ${userId}
        and t.deleted_at is null
        and t.temporary = false
        and m.role in ('user', 'assistant')
        -- Replies a retry replaced are not part of the conversation as it reads.
        and m.superseded_at is null
        and ${messageMatches}
    ),
    scores as (
      select thread_id, max(rank) as rank from hits group by thread_id
    ),
    candidates as (
      select
        t.id,
        coalesce(s.rank, 0)
          + case
              when ${titleVector} @@ ${titleQuery} then 1 + ts_rank(${titleVector}, ${titleQuery})
              when ${titleLike} then 0.5
              else 0
            end as rank,
        coalesce(t.last_message_at, t.updated_at) as activity
      from thread t
      left join scores s on s.thread_id = t.id
      where t.user_id = ${userId}
        and t.deleted_at is null
        and t.temporary = false
        and (s.thread_id is not null or ${titleMatches})
      order by rank desc, activity desc, t.id
      limit ${limit}
    )
    select
      c.id,
      c.rank::float8 as rank,
      ts_headline('simple'::regconfig, ${titleBody}, ${headlineQuery(true, search.titleTerms, titleBody, titleQuery)}, ${TITLE_OPTIONS}) as title_highlight,
      coalesce((
        select json_agg(
          json_build_object(
            'messageId', best.id,
            'role', best.role,
            'snippet', ts_headline(
              'simple'::regconfig,
              source.body,
              ${headlineQuery(search.folded, search.terms, sql`source.body`, query)},
              ${SNIPPET_OPTIONS}
            )
          )
          order by best.rank desc, best.position
        )
        from (
          select h.id, h.role, h.rank, h.position
          from hits h
          where h.thread_id = c.id
          order by h.rank desc, h.position
          limit ${MATCHES_PER_THREAD}
        ) best
        join message m on m.id = best.id
        cross join lateral (select ${messageBody} as body) source
      ), '[]'::json) as matches
    from candidates c
    join thread t on t.id = c.id
    order by c.rank desc, c.activity desc, c.id
  `;
}

type SearchRow = {
  id: string;
  rank: number;
  title_highlight: string;
  matches: { messageId: string; role: 'user' | 'assistant'; snippet: string }[];
};

/**
 * A snippet as one line of readable text. The searchable text is the message's
 * Markdown, so ts_headline's fragments carried its syntax ("1. **360-degree
 * head rotation**: …", #206); that is removed first, while the line breaks it
 * relies on are still there, then the line breaks are collapsed.
 */
export function tidySnippet(snippet: string): string {
  return plainTextOfMarkdown(snippet).replace(/\s+/g, ' ').trim();
}

export type ThreadRow = typeof schema.thread.$inferSelect;

interface ThreadSearchHit {
  thread: ThreadRow;
  rank: number;
  titleHighlight: string;
  matches: SearchRow['matches'];
}

/**
 * Searches the signed-in person's own conversations by title and message text.
 * Trashed and temporary conversations are excluded; archived ones are included
 * (and flagged by their summary), because search is how people find them.
 */
export async function searchThreads(
  userId: string,
  rawQuery: string,
  options: { limit?: number } = {},
): Promise<ThreadSearchHit[]> {
  const search = await parseSearchQuery(rawQuery, await foldedSearchReady());
  if (!search) return [];

  const limit = clampSearchLimit(options.limit);
  const rows = await db.execute<SearchRow>(threadSearchStatement(userId, search, rawQuery, limit));
  if (rows.length === 0) return [];

  const threads = await db
    .select()
    .from(schema.thread)
    .where(
      and(
        inArray(
          schema.thread.id,
          rows.map((row) => row.id),
        ),
        eq(schema.thread.userId, userId),
        isNull(schema.thread.deletedAt),
      ),
    );
  const byId = new Map(threads.map((thread) => [thread.id, thread]));

  return rows.flatMap((row) => {
    const thread = byId.get(row.id);
    if (!thread) return [];
    return [
      {
        thread,
        rank: Number(row.rank),
        titleHighlight: row.title_highlight,
        matches: (row.matches ?? []).map((match) => ({
          messageId: match.messageId,
          role: match.role,
          snippet: tidySnippet(match.snippet ?? ''),
        })),
      },
    ];
  });
}
