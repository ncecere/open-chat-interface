import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldAccents } from '../../lib/fold.js';

describe('accent folding for search (#362)', () => {
  it('turns accented Latin letters into their base letters and leaves other scripts alone', () => {
    expect(foldAccents('Bibliothèque Búsqueda Ștefan Đorđe Łódź Việt Nam Ñandú Ærø')).toBe(
      // Æ becomes two letters since v0.13 (oci_fold_search_text).
      'Bibliotheque Busqueda Stefan Dorde Lodz Viet Nam Nandu AEro',
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
});
