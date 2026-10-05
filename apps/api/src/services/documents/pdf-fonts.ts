import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PDF_FONT_FACES, type PdfFontFamily, sliceFile } from './pdf-font-faces.js';
import { STAND_INS, winAnsi } from './pdf-winansi.js';

type Doc = PDFKit.PDFDocument;

const require = createRequire(import.meta.url);

interface Slice {
  name: string;
  file: string;
  /** Sorted, inclusive [from, to] pairs. */
  ranges: number[];
  failed?: boolean;
}

interface Face {
  family: PdfFontFamily;
  weight: 400 | 700;
  italic: boolean;
  slices: Slice[];
}

function parseRanges(value: string): number[] {
  const pairs: Array<[number, number]> = [];
  for (const part of value.split(',')) {
    const match = /^\s*U\+([0-9a-f]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
    if (!match) continue;
    const from = Number.parseInt(match[1]!, 16);
    pairs.push([from, match[2] ? Number.parseInt(match[2], 16) : from]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.flat();
}

function inRanges(ranges: number[], code: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (code < ranges[middle * 2]!) high = middle - 1;
    else if (code > ranges[middle * 2 + 1]!) low = middle + 1;
    else return true;
  }
  return false;
}

/** A Fontsource package's directory, or null when it is not installed (or was pruned away). */
function packageDir(id: string): string | null {
  try {
    return dirname(require.resolve(`@fontsource/${id}`));
  } catch {
    return null;
  }
}

/** Every face whose package is installed, with its slices' character ranges. */
export function loadFontCatalog(): Face[] {
  const faces: Face[] = [];
  for (const face of PDF_FONT_FACES) {
    const dir = packageDir(face.id);
    if (!dir) continue;
    let unicode: Record<string, string>;
    try {
      unicode = JSON.parse(readFileSync(join(dir, 'unicode.json'), 'utf8'));
    } catch {
      continue;
    }
    const subsets = face.subsets ?? Object.keys(unicode);
    for (const weight of face.weights)
      for (const italic of face.italic ? [false, true] : [false])
        faces.push({
          family: face.family,
          weight,
          italic,
          slices: subsets.flatMap((subset) =>
            unicode[subset]
              ? [
                  {
                    name: `${face.id}:${subset}:${weight}${italic ? 'i' : ''}`,
                    file: join(dir, 'files', sliceFile(face.id, subset, weight, italic)),
                    ranges: parseRanges(unicode[subset]!),
                  },
                ]
              : [],
          ),
        });
  }
  return faces;
}

const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

/**
 * The CJK families in the order this document prefers them: Japanese when it
 * has kana, Korean when it has Hangul, otherwise Chinese (simplified), so
 * shared ideographs take the forms the document's language uses.
 */
export function cjkOrder(text: string): PdfFontFamily[] {
  if (KANA.test(text)) return ['jp', 'sc', 'kr'];
  if (HANGUL.test(text)) return ['kr', 'sc', 'jp'];
  return ['sc', 'jp', 'kr'];
}

/** Whether a document needs the embedded fonts: it has text Windows-1252 cannot draw. */
export function needsUnicodeFonts(text: string): boolean {
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0)!;
    if (char === '\n' || char === '\t' || winAnsi(code) || STAND_INS[char] !== undefined) continue;
    return true;
  }
  return false;
}

export interface PickedFont {
  /** The registered pdfkit font name. */
  name: string;
  /** Bold asked for, but the face has one weight: draw with an outline. */
  fauxBold: boolean;
}

const COURIER = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];

/** Chooses (and registers with pdfkit, on first use) a font for each character. */
export class FontBook {
  private readonly faces: Face[];
  private readonly chain: PdfFontFamily[];
  private readonly cache = new Map<string, PickedFont | null>();
  private readonly registered = new Set<string>();

  constructor(
    private readonly doc: Doc,
    cjk: PdfFontFamily[],
    faces: Face[] = loadFontCatalog(),
  ) {
    this.faces = faces;
    this.chain = ['sans', 'arabic', 'hebrew', ...cjk, 'symbols'];
  }

  /** Whether the base family (Latin, Greek, Cyrillic) is installed at all. */
  get available(): boolean {
    return this.faces.some((face) => face.family === 'sans');
  }

  pick(code: number, bold: boolean, italic: boolean, monospace = false): PickedFont | null {
    if (monospace && winAnsi(code))
      return { name: COURIER[(bold ? 1 : 0) + (italic ? 2 : 0)]!, fauxBold: false };
    const key = `${code}:${bold ? 1 : 0}${italic ? 1 : 0}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let picked: PickedFont | null = null;
    for (const family of this.chain) {
      picked = this.pickFrom(family, code, bold, italic);
      if (picked) break;
    }
    this.cache.set(key, picked);
    return picked;
  }

  private pickFrom(
    family: PdfFontFamily,
    code: number,
    bold: boolean,
    italic: boolean,
  ): PickedFont | null {
    const faces = this.faces.filter((face) => face.family === family);
    if (!faces.length) return null;
    const weight = bold && faces.some((face) => face.weight === 700) ? 700 : 400;
    const slant = italic && faces.some((face) => face.italic);
    const face =
      faces.find((candidate) => candidate.weight === weight && candidate.italic === slant) ??
      faces[0]!;
    for (const slice of face.slices) {
      if (slice.failed || !inRanges(slice.ranges, code)) continue;
      // A slice's range is not always exact (Noto Sans SC lists Hangul it lacks).
      if (!this.register(slice) || !this.covers(slice.name, code)) continue;
      return { name: slice.name, fauxBold: bold && face.weight !== 700 };
    }
    return null;
  }

  private covers(name: string, code: number): boolean {
    const opened = this.doc.font(name) as unknown as {
      _font: { font?: { hasGlyphForCodePoint(code: number): boolean } };
    };
    return opened._font.font?.hasGlyphForCodePoint(code) ?? false;
  }

  private register(slice: Slice): boolean {
    if (this.registered.has(slice.name)) return true;
    try {
      this.doc.registerFont(slice.name, readFileSync(slice.file));
      this.registered.add(slice.name);
      return true;
    } catch {
      // Pruned or unreadable: the next family is tried instead.
      slice.failed = true;
      return false;
    }
  }
}
