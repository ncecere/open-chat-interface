import { sql } from '@oci/db';

type SQL = ReturnType<typeof sql.raw>;

/**
 * Accent-insensitive matching for search (#362): "bibliotheque" finds
 * "bibliothèque" and "busqueda" finds "Búsqueda".
 *
 * PostgreSQL's `unaccent` is an extension (and `unaccent()` is not IMMUTABLE,
 * so an index cannot use it directly), so the folding is `translate()` with a
 * fixed table: every precomposed Latin letter with diacritics (Latin-1,
 * Latin Extended-A and -B, Vietnamese) becomes its base letter, character for
 * character. `translate` is IMMUTABLE, so the same expression can be indexed.
 * Letters of other scripts are untouched: decomposing them (NFD) would split
 * Arabic hamza forms and Japanese voiced kana into separate characters.
 * `ß`, `æ` and `œ` become two letters (`ss`, `ae`, `oe`), which `translate()`
 * cannot do, so the function replaces them after it (FOLD_EXPANSIONS).
 *
 * The one definition is the SQL function `oci_fold_search_text` (migration
 * 0047), which the trigger that stores folded search vectors, the queries and
 * the titles all call. This file holds the same table for the TypeScript side
 * and for tests, which keep the migration's literals equal to it.
 *
 * The two strings are spliced into SQL as literals, never parameters: the
 * planner uses an expression index only when the query has the same constants.
 * The optional index (packages/db/optional) holds the same literals; a test keeps them equal.
 */

/** Letters that are one base letter with marks added, by their Unicode decomposition. */
const DECOMPOSED_LATIN = /^[A-Za-z][\u0300-\u036f]+$/;
/** Latin-1 Supplement to Latin Extended-B, then Latin Extended Additional (Vietnamese). */
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00c0, 0x024f],
  [0x1e00, 0x1eff],
];
/** Letters whose "accent" is a stroke, so they have no decomposition. */
const STROKED = ['ØO', 'øo', 'ĐD', 'đd', 'ŁL', 'łl', 'ĦH', 'ħh', 'ıi'];

function foldingTable(): { from: string; to: string } {
  const pairs = new Map<string, string>();
  for (const [first, last] of RANGES) {
    for (let code = first; code <= last; code += 1) {
      const letter = String.fromCodePoint(code);
      const decomposed = letter.normalize('NFD');
      if (decomposed !== letter && DECOMPOSED_LATIN.test(decomposed)) {
        pairs.set(letter, decomposed.slice(0, 1));
      }
    }
  }
  for (const [letter, base] of STROKED.map((pair) => [pair.slice(0, 1), pair.slice(1)] as const)) {
    pairs.set(letter, base);
  }
  const letters = [...pairs.keys()];
  return { from: letters.join(''), to: letters.map((letter) => pairs.get(letter)).join('') };
}

const TABLE = foldingTable();

/** The literals `translate(value, FROM, TO)` takes, as they appear in SQL. */
export const FOLD_FROM = TABLE.from;
export const FOLD_TO = TABLE.to;

/**
 * Letters that become two, in both cases, replaced after `translate()` in the
 * SQL function and here. Not in FOLD_FROM: `translate()` maps one to one.
 */
export const FOLD_EXPANSIONS = [
  ['ß', 'ss'],
  ['ẞ', 'SS'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
] as const;

/**
 * `translate(<expression>, FROM, TO)` over raw SQL text (no quotes inside the
 * table): the one-to-one part only, which is what the optional message index
 * (packages/db/optional, removed by the stored folded vector) holds.
 */
export function foldSqlText(expression: string): string {
  return `translate(${expression}, '${FOLD_FROM}', '${FOLD_TO}')`;
}

/** The fold over a SQL value (a column or a bound parameter): the database's one definition. */
export function foldSql(value: SQL | string): SQL {
  const operand = typeof value === 'string' ? sql.raw(value) : value;
  return sql`oci_fold_search_text(${operand})`;
}

/** The fold in JavaScript, for tests and for comparing against what SQL does. */
export function foldAccents(value: string): string {
  const to = [...FOLD_TO];
  const index = new Map<string, string>([
    ...[...FOLD_FROM].map((letter, position): [string, string] => [letter, to[position] ?? letter]),
    ...FOLD_EXPANSIONS.map(([letter, expansion]): [string, string] => [letter, expansion]),
  ]);
  return [...value].map((letter) => index.get(letter) ?? letter).join('');
}

/**
 * `column ilike '%value%'` ignoring accents too (a title search): both sides
 * are folded, and `ilike` ignores case. The column is not indexed for this
 * (a pattern with a leading `%` never was).
 */
export function foldedIlike(column: SQL, pattern: string): SQL {
  return sql`${foldSql(column)} ilike ${foldSql(sql`${pattern.normalize('NFC')}::text`)}`;
}
