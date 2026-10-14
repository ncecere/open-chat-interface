import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FOLD_CANDIDATES,
  FOLD_EXPANSIONS,
  FOLD_FROM,
  FOLD_TO,
  foldAccents,
} from '../../lib/fold.js';

/**
 * The search fold (#362, SPEC-accent-search.md): one definition in the
 * database, `oci_fold_search_text` (migration 0047), and the same table here
 * for tests and for the TypeScript side. Letters that become two ("ß" is
 * "ss") cannot go through `translate()`, which maps one character to one.
 */
const migration = readFileSync(
  fileURLToPath(
    new URL('../../../../../packages/db/drizzle/0047_fold_search_text.sql', import.meta.url),
  ),
  'utf8',
);

describe('the search fold in TypeScript', () => {
  it('expands the letters that become two, as the function does', () => {
    expect(foldAccents('Straße STRAẞE œuvre ŒUVRE Ærø æther')).toBe(
      'Strasse STRASSE oeuvre OEUVRE AEro aether',
    );
    // One-to-one letters and other scripts are as before.
    expect(foldAccents('Bibliothèque Búsqueda Ștefan Việt')).toBe(
      'Bibliotheque Busqueda Stefan Viet',
    );
    expect(foldAccents('日本語 Привет أحمد')).toBe('日本語 Привет أحمد');
  });

  it('keeps expanded letters out of the one-to-one table', () => {
    for (const [letter] of FOLD_EXPANSIONS) expect(FOLD_FROM).not.toContain(letter);
  });
});

describe('the prefilter that skips the fold for text with nothing to fold', () => {
  const candidate = new RegExp(FOLD_CANDIDATES);

  it('matches every letter the fold can change, so skipping never loses a fold', () => {
    for (const letter of [...FOLD_FROM, ...FOLD_EXPANSIONS.map(([from]) => from)])
      expect(candidate.test(letter), `${letter} U+${letter.codePointAt(0)!.toString(16)}`).toBe(
        true,
      );
  });

  it('does not match plain text, or the scripts the fold leaves alone', () => {
    for (const text of ['Plain English, 123 !?', '日本語の宿題', 'Привет', 'مرحبا', '한국어 नमस्ते'])
      expect(candidate.test(text), text).toBe(false);
  });
});

describe('migration 0047', () => {
  it('holds the same table as fold.ts, literal for literal', () => {
    expect(migration).toContain(`translate(value, '${FOLD_FROM}', '${FOLD_TO}')`);
    for (const [letter, expansion] of FOLD_EXPANSIONS)
      expect(migration).toContain(`'${letter}', '${expansion}'`);
  });

  it('carries the same prefilter range', () => {
    expect(migration).toContain(`value !~ '${FOLD_CANDIDATES}'`);
  });

  it('defines an immutable function, so a stored or indexed value can rely on it', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION "oci_fold_search_text"/);
    expect(migration).toMatch(/\bIMMUTABLE\b/);
    expect(migration).toMatch(/\bSTRICT\b/);
  });
});
