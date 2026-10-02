import { and, eq, inArray, isNull, schema, sql } from '@oci/db';
import {
  SEARCH_HIGHLIGHT_END,
  SEARCH_HIGHLIGHT_START,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
} from '@oci/shared';
import { db } from '../db/index.js';

type SQL = ReturnType<typeof sql.raw>;

/** Longer input is cut, not refused: a pasted paragraph still searches its opening words. */
export const SEARCH_QUERY_MAX_CHARS = 200;
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

/** The same text parts as one string, for snippets. Not indexed, so its form is free. */
function messageSearchText(alias: string): SQL {
  return sql.raw(
    `(select string_agg(part #>> '{}', E'\\n') from jsonb_array_elements(jsonb_path_query_array("${alias}"."parts", ${JSON_TEXT_PATH})) as texts(part) where jsonb_typeof(part) = 'string')`,
  );
}

/** Removes the highlight markers and other control characters from stored or typed text. */
function stripControls(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

/** Quotes a lexeme as a tsquery operand. Lexemes come from Postgres, never from raw input. */
function tsqueryOperand(lexeme: string): string {
  return `'${lexeme.replaceAll('\\', '\\\\').replaceAll("'", "''")}':*`;
}

/**
 * Turns free text into a prefix query: every word must appear, each matched as
 * a prefix (`plan` finds "planning"). The words are split by Postgres's own
 * parser with the same configuration as the index, so e-mail addresses,
 * hyphenated words and numbers tokenise exactly as they do in messages.
 * Operators and punctuation are never interpreted: the raw text is only ever a
 * bound parameter to `to_tsvector`. Returns null when nothing searchable is left.
 */
export async function parseSearchQuery(raw: string): Promise<string | null> {
  const text = stripControls(raw.normalize('NFC').slice(0, SEARCH_QUERY_MAX_CHARS)).trim();
  if (!text) return null;

  const rows = await db.execute<{ lexeme: string }>(sql`
    select lexeme
    from unnest(to_tsvector('simple'::regconfig, ${text})) as words(lexeme, positions, weights)
    order by positions[1]
  `);
  let lexemes = rows.map((row) => row.lexeme).filter(Boolean);
  // A lone letter left over from "it's" matches nearly everything as a prefix.
  const longer = lexemes.filter((lexeme) => [...lexeme].length > 1);
  if (longer.length > 0) lexemes = longer;
  lexemes = lexemes.slice(0, MAX_TERMS);

  return lexemes.length > 0 ? lexemes.map(tsqueryOperand).join(' & ') : null;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
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

export function clampSearchLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return THREAD_SEARCH_DEFAULT_LIMIT;
  return Math.min(THREAD_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The ranked search over one person's conversations. Exported so tests can
 * EXPLAIN exactly what runs.
 */
export function threadSearchStatement(
  userId: string,
  tsquery: string,
  rawQuery: string,
  limit: number,
) {
  const query = sql`${tsquery}::tsquery`;
  const titleVector = sql`to_tsvector('simple'::regconfig, t.title)`;
  const pattern = likePattern(stripControls(rawQuery).trim().slice(0, SEARCH_QUERY_MAX_CHARS));
  const titleMatches = sql`(${titleVector} @@ ${query} or t.title ilike ${pattern} escape '\\')`;

  return sql`
    with hits as materialized (
      select m.id, m.thread_id, m.role, m.position, ts_rank(${messageSearchVector('m')}, ${query}) as rank
      from message m
      join thread t on t.id = m.thread_id
      where t.user_id = ${userId}
        and t.deleted_at is null
        and t.temporary = false
        and m.role in ('user', 'assistant')
        -- Replies a retry replaced are not part of the conversation as it reads.
        and m.superseded_at is null
        and ${messageSearchVector('m')} @@ ${query}
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
              when t.title ilike ${pattern} escape '\\' then 0.5
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
      ts_headline('simple'::regconfig, translate(t.title, chr(1) || chr(2), '  '), ${query}, ${TITLE_OPTIONS}) as title_highlight,
      coalesce((
        select json_agg(
          json_build_object(
            'messageId', best.id,
            'role', best.role,
            'snippet', ts_headline(
              'simple'::regconfig,
              translate(left(${messageSearchText('m')}, ${SNIPPET_SOURCE_MAX_CHARS}), chr(1) || chr(2), '  '),
              ${query},
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

/** Collapses the line breaks ts_headline keeps, so a snippet reads as one line. */
function tidySnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

export type ThreadRow = typeof schema.thread.$inferSelect;

export interface ThreadSearchHit {
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
  const tsquery = await parseSearchQuery(rawQuery);
  if (!tsquery) return [];

  const limit = clampSearchLimit(options.limit);
  const rows = await db.execute<SearchRow>(threadSearchStatement(userId, tsquery, rawQuery, limit));
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
