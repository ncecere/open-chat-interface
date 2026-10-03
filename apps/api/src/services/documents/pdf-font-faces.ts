/**
 * The font faces PDF export may embed (v0.10), from the Noto families
 * packaged by Fontsource (SIL Open Font License 1.1). Each package ships a
 * family as slices: by script (latin, greek, cyrillic, …) or, for Chinese,
 * Japanese and Korean, as about a hundred frequency-ordered subsets of a few
 * hundred characters each. Only the slices a document uses are read and
 * embedded (and pdfkit embeds only the glyphs used).
 *
 * This list is also what the API image keeps (`scripts/prune-pdf-fonts.mjs`
 * deletes every other file of these packages at build), so it is plain data
 * with no imports. See docs/dev/v0.10-design-artifacts.md.
 */

export type PdfFontFamily = 'sans' | 'arabic' | 'hebrew' | 'symbols' | 'sc' | 'jp' | 'kr';

export interface PdfFontFace {
  family: PdfFontFamily;
  /** The Fontsource package, `@fontsource/<id>`. */
  id: string;
  /** Slice names in `unicode.json`; null: every slice (the CJK subsets). */
  subsets: readonly string[] | null;
  weights: readonly (400 | 700)[];
  italic: boolean;
}

export const PDF_FONT_FACES: readonly PdfFontFace[] = [
  {
    family: 'sans',
    id: 'noto-sans',
    subsets: [
      'latin',
      'latin-ext',
      'vietnamese',
      'greek',
      'greek-ext',
      'cyrillic',
      'cyrillic-ext',
      'devanagari',
    ],
    weights: [400, 700],
    italic: true,
  },
  {
    family: 'arabic',
    id: 'noto-sans-arabic',
    subsets: ['arabic'],
    weights: [400, 700],
    italic: false,
  },
  {
    family: 'hebrew',
    id: 'noto-sans-hebrew',
    subsets: ['hebrew'],
    weights: [400, 700],
    italic: false,
  },
  // Arrows, maths, box drawing, geometric shapes, dingbats: from the Arabic package.
  {
    family: 'symbols',
    id: 'noto-sans-arabic',
    subsets: ['symbols', 'math'],
    weights: [400],
    italic: false,
  },
  // One weight for the large families: bold is drawn with a thin outline.
  { family: 'sc', id: 'noto-sans-sc', subsets: null, weights: [400], italic: false },
  { family: 'jp', id: 'noto-sans-jp', subsets: null, weights: [400], italic: false },
  { family: 'kr', id: 'noto-sans-kr', subsets: null, weights: [400], italic: false },
];

/**
 * A slice's file name: `noto-sans-sc-118-400-normal.woff` for subset
 * `[118]`. WOFF, not WOFF2: WOFF2 transforms the glyph table, and fontkit
 * (which pdfkit uses to subset the font it embeds) cannot copy compound
 * glyphs out of a transformed table.
 */
export function sliceFile(id: string, subset: string, weight: number, italic: boolean): string {
  return `${id}-${subset.replace(/^\[(\d+)\]$/, '$1')}-${weight}-${italic ? 'italic' : 'normal'}.woff`;
}
