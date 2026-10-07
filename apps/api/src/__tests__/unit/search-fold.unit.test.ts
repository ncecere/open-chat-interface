import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldAccents } from '../../lib/fold.js';
import {
  FOLDED_SEARCH_STEP,
  foldedMessageSearchVectorText,
  messageSearchVector,
} from '../../services/thread-search.js';

const step = readFileSync(
  fileURLToPath(
    new URL(`../../../../../packages/db/post/${FOLDED_SEARCH_STEP}.sql`, import.meta.url),
  ),
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

  it('is the expression post-deploy step 0012 indexes, character for character', () => {
    const expression = foldedMessageSearchVectorText('m');
    // The index is on the column, the query on the aliased column.
    expect(step.replace(/\s+/g, ' ')).toContain(
      expression.replace(/"m"\."parts"/g, '"parts"').replace(/\s+/g, ' '),
    );
    // The step builds a separate index: the old expression is still the old index's.
    expect(messageSearchVector('m').queryChunks.map(String).join('')).not.toContain('translate(');
    expect(step).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_text_search_folded_idx"',
    );
  });
});
