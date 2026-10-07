import { and, eq, inArray, isNull, schema, sql } from '@oci/db';
import {
  plainTextOfMarkdown,
  SEARCH_HIGHLIGHT_END,
  SEARCH_HIGHLIGHT_START,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
} from '@oci/shared';
import { db } from '../db/index.js';
import { foldSql, foldSqlText } from '../lib/fold.js';
import { containsPattern } from '../lib/like.js';
import { stripControls, tsqueryOperand } from '../lib/text.js';
import { isPostStepDone } from './migrations/readiness.js';
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
 * Post-deploy step that builds the index over the accent-folded text (#362).
 * Until it has run, search is exact about accents, as before: the folded
 * expression below would be answered by scanning every message.
 */
export const FOLDED_SEARCH_STEP = '0012_message_text_search_folded_index';

/** True when the folded index exists; false while it is being built, or when that cannot be told. */
export async function foldedSearchReady(): Promise<boolean> {
  try {
    return await isPostStepDone(FOLDED_SEARCH_STEP);
  } catch {
    return false;
  }
}

/**
 * The searchable document with accents folded (#362): the same text parts,
 * every accented Latin letter replaced by its base letter, so "bibliotheque"
 * finds "bibliothèque". The JSON text is folded and read back as JSON (the
 * table only changes letters, never JSON syntax), so `to_tsvector` still
 * indexes string values only.
 *
 * Must stay character-for-character the expression of post-deploy step 0012
 * (`message_text_search_folded_idx`); a unit test compares them.
 */
export function foldedMessageSearchVectorText(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('Invalid table alias');
  const text = `jsonb_path_query_array("${alias}"."parts", ${JSON_TEXT_PATH})::text`;
  return `to_tsvector('simple'::regconfig, ${foldSqlText(text)}::jsonb)`;
}

export const foldedMessageSearchVector = (alias: string): SQL =>
  sql.raw(foldedMessageSearchVectorText(alias));

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

  // Folded the way the indexed text is, so the words meet as the index holds them (#362).
  const subject = folded ? foldSql(sql`${text}::text`) : sql`${text}`;
  const rows = await db.execute<{ lexeme: string }>(sql`
    select lexeme
    from unnest(to_tsvector('simple'::regconfig, ${subject})) as words(lexeme, positions, weights)
    order by positions[1]
  `);
  let lexemes = rows.map((row) => row.lexeme).filter(Boolean);
  // A lone letter left over from "it's" matches nearly everything as a prefix.
  const longer = lexemes.filter((lexeme) => [...lexeme].length > 1);
  if (longer.length > 0) lexemes = longer;
  lexemes = lexemes.slice(0, MAX_TERMS);

  return lexemes.length > 0
    ? {
        tsquery: lexemes.map((lexeme) => tsqueryOperand(lexeme, true)).join(' & '),
        terms: lexemes,
        folded,
      }
    : null;
}

/** A search as the database runs it. */
export interface ParsedQuery {
  tsquery: string;
  /** The words, each matched as a prefix; folded when `folded`. */
  terms: string[];
  /** Whether accents are ignored (the folded index exists, #362). */
  folded: boolean;
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
function headlineQuery(search: ParsedQuery, body: SQL, query: SQL): SQL {
  if (!search.folded) return query;
  return sql`coalesce((
    select string_agg(
      '''' || replace(replace(matched.lexeme, ${ONE_BACKSLASH}, ${TWO_BACKSLASHES}), '''', '''''') || '''',
      ' | '
    )::tsquery
    from (
      select words.lexeme
      from unnest(to_tsvector('simple'::regconfig, ${body})) as words(lexeme, positions, weights)
      where exists (
        select 1 from unnest(${textArray(search.terms)}) as wanted(term)
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
 * EXPLAIN exactly what runs. `search.folded` ignores accents (#362): the
 * words, the titles and the message index are all folded the same way.
 */
export function threadSearchStatement(
  userId: string,
  search: ParsedQuery,
  rawQuery: string,
  limit: number,
) {
  const query = sql`${search.tsquery}::tsquery`;
  const messageVector = (alias: string) =>
    search.folded ? foldedMessageSearchVector(alias) : messageSearchVector(alias);
  const titleText = search.folded ? foldSql('t.title') : sql`t.title`;
  const titleVector = sql`to_tsvector('simple'::regconfig, ${titleText})`;
  const typed = containsPattern(stripControls(rawQuery).trim().slice(0, SEARCH_QUERY_MAX_CHARS));
  const pattern = search.folded ? foldSql(sql`${typed}::text`) : sql`${typed}`;
  const titleLike = sql`${titleText} ilike ${pattern} escape '\\'`;
  const titleMatches = sql`(${titleVector} @@ ${query} or ${titleLike})`;
  const titleBody = sql`translate(t.title, chr(1) || chr(2), '  ')`;
  const messageBody = sql`translate(left(${messageSearchText('m')}, ${SNIPPET_SOURCE_MAX_CHARS}), chr(1) || chr(2), '  ')`;

  return sql`
    with hits as materialized (
      select m.id, m.thread_id, m.role, m.position, ts_rank(${messageVector('m')}, ${query}) as rank
      from message m
      join thread t on t.id = m.thread_id
      where t.user_id = ${userId}
        and t.deleted_at is null
        and t.temporary = false
        and m.role in ('user', 'assistant')
        -- Replies a retry replaced are not part of the conversation as it reads.
        and m.superseded_at is null
        and ${messageVector('m')} @@ ${query}
    ),
    scores as (
      select thread_id, max(rank) as rank from hits group by thread_id
    ),
    candidates as (
      select
        t.id,
        coalesce(s.rank, 0)
          + case
              when ${titleVector} @@ ${query} then 1 + ts_rank(${titleVector}, ${query})
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
      ts_headline('simple'::regconfig, ${titleBody}, ${headlineQuery(search, titleBody, query)}, ${TITLE_OPTIONS}) as title_highlight,
      coalesce((
        select json_agg(
          json_build_object(
            'messageId', best.id,
            'role', best.role,
            'snippet', ts_headline(
              'simple'::regconfig,
              source.body,
              ${headlineQuery(search, sql`source.body`, query)},
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
