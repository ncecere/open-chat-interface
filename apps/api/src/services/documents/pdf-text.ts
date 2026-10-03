import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import bidiFactory from 'bidi-js';
import { PDF_FONT_FACES, type PdfFontFamily, sliceFile } from './pdf-font-faces.js';
import { STAND_INS, winAnsi } from './pdf-winansi.js';

/**
 * Text in every script for PDF export (v0.10).
 *
 * A document whose text fits Windows-1252 is drawn as before, with the PDF
 * standard fonts. Any other document is drawn here with embedded Noto fonts
 * (pdf-font-faces.ts), chosen per run of characters: each character takes the
 * first family that has it (Noto Sans for Latin, Greek and Cyrillic, then
 * Arabic, Hebrew, the document's CJK family, the other CJK families, then
 * symbols), and consecutive characters with the same font are drawn together,
 * so pdfkit's fontkit shapes them (Arabic joining forms, ligatures, marks).
 *
 * pdfkit lays text out left to right and has no bidirectional algorithm, so
 * lines are broken and ordered here: the Unicode Bidirectional Algorithm
 * (bidi-js) resolves embedding levels per paragraph, each line is reordered
 * visually (rule L2), and each run is drawn at its position. A right-to-left
 * run of Arabic or Hebrew is given to fontkit in logical order (it reverses
 * right-to-left scripts itself); other runs at a right-to-left level (digits
 * excepted, which the algorithm keeps left to right) are given in visual
 * order, brackets mirrored. Paragraphs start on the side of their first
 * strong character.
 *
 * Emoji have no font here: each is drawn as U+FFFD, as is any character no
 * bundled font has. Variation selectors, joiners and skin-tone modifiers are
 * dropped. CJK, Arabic and Hebrew have no italic; CJK has one weight, and
 * bold is drawn with a thin outline.
 */

type Doc = PDFKit.PDFDocument;

export const LINK_COLOR = '#1a56db';

const require = createRequire(import.meta.url);
const bidi = bidiFactory();

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

/** A piece of styled text, as the document model's runs. */
export interface Span {
  text: string;
  size: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  /** Monospaced: Courier where Windows-1252 covers it. */
  code?: boolean;
  href?: string | null;
  strike?: boolean;
}

interface Char {
  text: string;
  span: number;
  font: string;
  fauxBold: boolean;
  size: number;
  level: number;
  /** Bidi class R or AL: drawn by fontkit right to left. */
  rtlScript: boolean;
}

interface Group {
  text: string;
  span: Span;
  font: string;
  fauxBold: boolean;
  size: number;
  width: number;
}

export interface TextLine {
  groups: Group[];
  width: number;
  ascent: number;
  height: number;
  /** The paragraph's base direction is right to left. */
  rtl: boolean;
}

export type TextAlign = 'start' | 'left' | 'center' | 'right';

/** Not drawn: controls, zero-width and bidi format characters, variation selectors, skin tones, tags. */
const DROPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff],
  [0xe0000, 0xe0fff],
];
const dropped = (code: number) => DROPPED_RANGES.some(([from, to]) => code >= from && code <= to);
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK = /\p{M}/u;
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const SPACE = /[ \u3000]/;
const CJK =
  /[\u2e80-\u2fff\u3001-\u303f\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3ffff}]/u;
/** Not at the start of a line (closing punctuation, small kana). */
const NO_BREAK_BEFORE =
  /[、。，．・：；？！）」』】〕〉》〙〗ヽヾーゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ!),.:;?\]}%]/u;
/** Not at the end of a line (opening punctuation). */
const NO_BREAK_AFTER = /[（「『【〔〈《〘〖([{]/u;
export const PLACEHOLDER = '\ufffd';

function isEmoji(char: string, code: number): boolean {
  return EMOJI.test(char) || (code >= 0x1f000 && PICTOGRAPHIC.test(char));
}

/** Lays out and draws text in any script; see the module comment. */
export class TextEngine {
  private readonly widths = new Map<string, number>();
  private readonly metrics = new Map<string, { ascender: number; descender: number }>();

  constructor(
    private readonly doc: Doc,
    private readonly fonts: FontBook,
  ) {}

  private font(name: string, size: number): Doc {
    return this.doc.font(name).fontSize(size);
  }

  private width(font: string, size: number, text: string): number {
    const key = `${font}\u0000${size}\u0000${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    const width = this.font(font, size).widthOfString(text);
    if (text.length <= 32) this.widths.set(key, width);
    return width;
  }

  private metric(font: string): { ascender: number; descender: number } {
    let metric = this.metrics.get(font);
    if (!metric) {
      const current = (
        this.doc.font(font) as unknown as { _font: { ascender: number; descender: number } }
      )._font;
      metric = { ascender: current.ascender, descender: current.descender };
      this.metrics.set(font, metric);
    }
    return metric;
  }

  /** The characters of the spans with their fonts, split at hard line breaks. */
  private characters(spans: readonly Span[]): Array<Array<Omit<Char, 'level'>>> {
    const lines: Array<Array<Omit<Char, 'level'>>> = [[]];
    spans.forEach((span, index) => {
      const add = (text: string, font: PickedFont) =>
        lines.at(-1)!.push({
          text,
          span: index,
          font: font.name,
          fauxBold: font.fauxBold,
          size: span.size,
          rtlScript: RTL_SCRIPT.test(text),
        });
      const pick = (code: number) =>
        this.fonts.pick(code, Boolean(span.bold), Boolean(span.italic), Boolean(span.code));
      for (const raw of span.text.normalize('NFC')) {
        if (raw === '\n') {
          lines.push([]);
          continue;
        }
        if (raw === '\t') {
          const font = pick(0x20);
          if (font) for (let i = 0; i < 4; i++) add(' ', font);
          continue;
        }
        const code = raw.codePointAt(0)!;
        if (dropped(code)) continue;
        const previous = lines.at(-1)!.at(-1);
        // A combining mark stays with its base character's font.
        if (MARK.test(raw) && previous && previous.span === index) {
          lines.at(-1)!.push({ ...previous, text: raw, rtlScript: RTL_SCRIPT.test(raw) });
          continue;
        }
        const font = isEmoji(raw, code) ? null : pick(code);
        if (font) {
          add(raw, font);
          continue;
        }
        // No font has it: an ASCII stand-in, or the replacement character.
        const standIn = isEmoji(raw, code) ? undefined : STAND_INS[raw];
        const replacement = standIn !== undefined ? standIn : PLACEHOLDER;
        for (const char of replacement) {
          const substitute = pick(char.codePointAt(0)!);
          if (substitute) add(char, substitute);
        }
      }
    });
    return lines;
  }

  /** Width of characters [from, to) in logical order, measured per font run (so shaped). */
  private measure(chars: readonly Char[], from: number, to: number): number {
    let width = 0;
    let start = from;
    for (let i = from + 1; i <= to; i++) {
      const run = chars[start]!;
      const next = i < to ? chars[i] : undefined;
      if (next && next.font === run.font && next.size === run.size) continue;
      width += this.width(
        run.font,
        run.size,
        chars
          .slice(start, i)
          .map((char) => char.text)
          .join(''),
      );
      start = i;
    }
    return width;
  }

  /** Where a line may break: after index i. */
  private breakable(chars: readonly Char[], i: number): boolean {
    const here = chars[i]!.text;
    const next = chars[i + 1]?.text;
    if (next === undefined) return true;
    if (MARK.test(next)) return false;
    if (SPACE.test(here)) return !SPACE.test(next);
    if (here === '-' && !SPACE.test(next)) return true;
    if ((CJK.test(here) || CJK.test(next)) && !SPACE.test(next))
      return !NO_BREAK_AFTER.test(here) && !NO_BREAK_BEFORE.test(next);
    return false;
  }

  /** Line ranges [start, end) of one paragraph within `width` (trailing spaces included). */
  private breakLines(chars: readonly Char[], width: number): Array<[number, number]> {
    const lines: Array<[number, number]> = [];
    let lineStart = 0;
    let lineEnd = 0;
    const visibleEnd = (from: number, to: number) => {
      let end = to;
      while (end > from && SPACE.test(chars[end - 1]!.text)) end--;
      return end;
    };
    for (let i = 0; i < chars.length; i++) {
      if (!this.breakable(chars, i)) continue;
      const tokenEnd = i + 1;
      const fits = this.measure(chars, lineStart, visibleEnd(lineStart, tokenEnd)) <= width + 0.01;
      if (fits) lineEnd = tokenEnd;
      else {
        if (lineEnd > lineStart) {
          lines.push([lineStart, lineEnd]);
          lineStart = lineEnd;
        }
        // A single token wider than the line is split between characters.
        while (this.measure(chars, lineStart, visibleEnd(lineStart, tokenEnd)) > width + 0.01) {
          let cut = lineStart + 1;
          while (cut < tokenEnd && MARK.test(chars[cut]!.text)) cut++;
          while (cut < tokenEnd) {
            let next = cut + 1;
            while (next < tokenEnd && MARK.test(chars[next]!.text)) next++;
            if (this.measure(chars, lineStart, next) > width) break;
            cut = next;
          }
          if (cut >= tokenEnd) break;
          lines.push([lineStart, cut]);
          lineStart = cut;
        }
        lineEnd = tokenEnd;
      }
    }
    if (lineStart < chars.length || lines.length === 0) lines.push([lineStart, chars.length]);
    return lines;
  }

  /** One line, reordered visually and grouped into runs to draw. */
  private line(
    chars: readonly Char[],
    from: number,
    to: number,
    spans: readonly Span[],
    rtl: boolean,
    fallbackSize: number,
  ): TextLine {
    let end = to;
    while (end > from && SPACE.test(chars[end - 1]!.text)) end--;
    // Rule L2: reverse every run at or above each level, from the highest to the lowest odd one.
    const order = Array.from({ length: end - from }, (_, i) => from + i);
    const levels = order.map((i) => chars[i]!.level);
    const highest = Math.max(0, ...levels);
    const lowestOdd = Math.min(...levels.filter((level) => level % 2 === 1), highest + 1);
    for (let level = highest; level >= lowestOdd; level--) {
      for (let i = 0; i < order.length; ) {
        if (chars[order[i]!]!.level < level) {
          i++;
          continue;
        }
        let j = i;
        while (j < order.length && chars[order[j]!]!.level >= level) j++;
        order.splice(i, j - i, ...order.slice(i, j).reverse());
        i = j;
      }
    }
    const groups: Group[] = [];
    let ascent = 0;
    let descent = 0;
    for (let i = 0; i < order.length; ) {
      const first = chars[order[i]!]!;
      let j = i + 1;
      while (j < order.length) {
        const char = chars[order[j]!]!;
        if (
          char.font !== first.font ||
          char.size !== first.size ||
          char.span !== first.span ||
          char.fauxBold !== first.fauxBold ||
          char.level % 2 !== first.level % 2
        )
          break;
        j++;
      }
      const visual = order.slice(i, j).map((index) => chars[index]!);
      let text: string;
      if (first.level % 2 === 1 && visual.some((char) => char.rtlScript))
        // fontkit reverses right-to-left scripts itself: give it logical order.
        text = [...visual]
          .reverse()
          .map((char) => char.text)
          .join('');
      else if (first.level % 2 === 1)
        text = visual.map((char) => bidi.getMirroredCharacter(char.text) ?? char.text).join('');
      else text = visual.map((char) => char.text).join('');
      groups.push({
        text,
        span: spans[first.span]!,
        font: first.font,
        fauxBold: first.fauxBold,
        size: first.size,
        width: this.width(first.font, first.size, text),
      });
      const metric = this.metric(first.font);
      ascent = Math.max(ascent, (metric.ascender / 1000) * first.size);
      descent = Math.max(descent, (-metric.descender / 1000) * first.size);
      i = j;
    }
    if (!groups.length) {
      const base = this.fonts.pick(0x20, false, false);
      const metric = base ? this.metric(base.name) : { ascender: 1069, descender: -293 };
      ascent = (metric.ascender / 1000) * fallbackSize;
      descent = (-metric.descender / 1000) * fallbackSize;
    }
    return {
      groups,
      width: groups.reduce((sum, group) => sum + group.width, 0),
      ascent,
      height: ascent + descent + 2,
      rtl,
    };
  }

  /**
   * Breaks spans into lines of at most `width` points. `direction` 'auto'
   * takes each paragraph's direction from its first strong character.
   */
  layout(spans: readonly Span[], width: number, direction: 'auto' | 'ltr' = 'auto'): TextLine[] {
    const fallbackSize = spans[0]?.size ?? 10;
    const lines: TextLine[] = [];
    for (const paragraph of this.characters(spans)) {
      const text = paragraph.map((char) => char.text).join('');
      const resolved = bidi.getEmbeddingLevels(text, direction);
      const rtl = (resolved.paragraphs[0]?.level ?? 0) % 2 === 1;
      let offset = 0;
      const chars: Char[] = paragraph.map((char) => {
        const level = resolved.levels[offset] ?? 0;
        offset += char.text.length;
        return { ...char, level };
      });
      for (const [from, to] of this.breakLines(chars, width))
        lines.push(this.line(chars, from, to, spans, rtl, fallbackSize));
    }
    return lines;
  }

  /** Draws one line with its top at `y`. */
  drawLine(line: TextLine, x: number, width: number, y: number, align: TextAlign): void {
    const side = align === 'start' ? (line.rtl ? 'right' : 'left') : align;
    let left = x;
    if (side === 'right') left = x + width - line.width;
    else if (side === 'center') left = x + (width - line.width) / 2;
    const baseline = y + line.ascent;
    for (const group of line.groups) {
      const metric = this.metric(group.font);
      const top = baseline - (metric.ascender / 1000) * group.size;
      const color = group.span.href ? LINK_COLOR : group.span.color;
      this.font(group.font, group.size).fillColor(color);
      const options: PDFKit.Mixins.TextOptions = {
        lineBreak: false,
        link: group.span.href ?? null,
        underline: Boolean(group.span.href),
        strike: Boolean(group.span.strike),
      };
      if (group.fauxBold) {
        this.doc.save();
        this.doc.lineWidth(group.size * 0.035).strokeColor(color);
        this.doc.text(group.text, left, top, { ...options, fill: true, stroke: true });
        this.doc.restore();
      } else this.doc.text(group.text, left, top, options);
      left += group.width;
    }
  }
}
