import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldAccents } from '../../lib/fold.js';
import {
  FOLDED_SEARCH_INDEX,
  FOLDED_SEARCH_INDEX_FILE,
  foldedMessageSearchVectorText,
  messageSearchVector,
} from '../../services/thread-search.js';

// The folded message index is optional (an operator runs this file by hand), so
// it lives outside packages/db/post, where `migrate --post` would run it.
const optionalDir = '../../../../../packages/db/optional/';
const optionalSql = readFileSync(
  fileURLToPath(new URL(`${optionalDir}${FOLDED_SEARCH_INDEX_FILE}`, import.meta.url)),
  'utf8',
);
const postJournal = readFileSync(
  fileURLToPath(new URL('../../../../../packages/db/post/journal.json', import.meta.url)),
  'utf8',
);

describe('accent folding for search (#362)', () => {
  it('turns accented Latin letters into their base letters and leaves other scripts alone', () => {
    expect(foldAccents('Bibliothèque Búsqueda Ștefan Đorđe Łódź Việt Nam Ñandú Ærø')).toBe(
      'Bibliotheque Busqueda Stefan Dorde Lodz Viet Nam Nandu Æro',
    );
    // Decomposing these would split letters of the script into separate characters.
    for (const word of ['日本語', 'がっこう', 'أحمد', 'Привет', 'नमस्ते', '한국어']) {
      expect(foldAccents(word)).toBe(word);
    }
  });

  it('maps one character to one, so offsets and lengths never change', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(new Set([...FOLD_FROM]).size).toBe([...FOLD_FROM].length);
    expect([...FOLD_TO].every((letter) => /^[A-Za-z]$/.test(letter))).toBe(true);
    expect(FOLD_FROM).not.toMatch(/['\\]/);
  });

  it('is the expression the optional index holds, character for character', () => {
    const expression = foldedMessageSearchVectorText('m');
    // The index is on the column, the query on the aliased column.
    expect(optionalSql.replace(/\s+/g, ' ')).toContain(
      expression.replace(/"m"\."parts"/g, '"parts"').replace(/\s+/g, ' '),
    );
    // A separate index: the old expression is still the old index's.
    expect(messageSearchVector('m').queryChunks.map(String).join('')).not.toContain('translate(');
    expect(optionalSql).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${FOLDED_SEARCH_INDEX}"`,
    );
  });

  it('is not a shipped post-deploy step: an upgrade never builds it (about 1 ms per message)', () => {
    expect(postJournal).not.toContain(FOLDED_SEARCH_INDEX);
    expect(postJournal).not.toContain('folded');
    expect(
      readdirSync(fileURLToPath(new URL('../../../../../packages/db/post/', import.meta.url))),
    ).not.toContain(FOLDED_SEARCH_INDEX_FILE);
    // One statement, so an operator can also run it from any SQL client.
    expect(
      optionalSql
        .replace(/^--.*$/gm, '')
        .trim()
        .match(/;/g),
    ).toHaveLength(1);
  });
});
