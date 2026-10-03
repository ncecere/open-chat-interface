import PDFDocument from 'pdfkit';
import type { Align, Block, DocumentModel, Run, TableBlock } from './model.js';
import { runsText } from './model.js';

/**
 * PDF output with pdfkit (MIT), laid out here without a browser: A4, 2 cm
 * margins, the PDF standard fonts Helvetica and Courier.
 *
 * The standard fonts are not embedded and cover the Windows-1252 (Western
 * European) repertoire only. Accented Latin letters outside it are reduced to
 * their base letter ("ő" → "o"), a few symbols get ASCII stand-ins ("→" →
 * "->"), and anything else (Greek, Cyrillic, CJK, emoji) prints as "?".
 * Embedding a Unicode font was rejected: the fonts that cover those scripts are
 * OFL-licensed rather than MIT/Apache and add megabytes per script. DOCX keeps
 * every character and is the format to use for non-Latin text.
 */

type Doc = PDFKit.PDFDocument;

const MARGIN = 56.7; // 2 cm
const BODY = 10.5;
const CODE = 9;
const TABLE = 9;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 10.5];
const TEXT = '#1f1f1f';
const MUTED = '#595959';
const LINK = '#1a56db';
const RULE = '#bfbfbf';
const INDENT = 16;

const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018,
  0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a,
  0x20ac, 0x2122,
]);

const STAND_INS: Record<string, string> = {
  '\u2190': '<-',
  '\u2192': '->',
  '\u2194': '<->',
  '\u21d0': '<=',
  '\u21d2': '=>',
  '\u2212': '-',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2015': '-',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2260': '!=',
  '\u2248': '~',
  '\u2032': "'",
  '\u2033': '"',
  '\u2009': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u202f': ' ',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
  '\u2713': 'v',
  '\u2714': 'v',
  '\u2717': 'x',
  '\u2718': 'x',
  '\u25cf': '\u2022',
  '\u25e6': '\u2022',
  '\u25aa': '\u2022',
};

function winAnsi(code: number): boolean {
  return (
    (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code)
  );
}

/** Text the standard fonts can draw: see the module comment. */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0)!;
    if (char === '\n') out += char;
    else if (char === '\t') out += '    ';
    else if (winAnsi(code)) out += char;
    else if (STAND_INS[char] !== undefined) out += STAND_INS[char];
    else {
      const base = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      out += base && [...base].every((part) => winAnsi(part.codePointAt(0)!)) ? base : '?';
    }
  }
  return out;
}

function fontFor(run: { bold?: boolean; italic?: boolean; code?: boolean }): string {
  if (run.code) {
    if (run.bold && run.italic) return 'Courier-BoldOblique';
    if (run.bold) return 'Courier-Bold';
    if (run.italic) return 'Courier-Oblique';
    return 'Courier';
  }
  if (run.bold && run.italic) return 'Helvetica-BoldOblique';
  if (run.bold) return 'Helvetica-Bold';
  if (run.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

interface Style {
  size: number;
  bold?: boolean;
  color: string;
  align?: 'left' | 'center' | 'right';
}

interface Area {
  x: number;
  width: number;
  color: string;
}

export class TooLargeError extends Error {}

class PdfWriter {
  constructor(private readonly doc: Doc) {}

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Starts a new page unless `height` more points fit on this one. */
  private ensure(height: number): void {
    if (this.doc.y + height > this.bottom) this.doc.addPage();
  }

  private lineHeight(size: number, font = 'Helvetica'): number {
    return this.doc.font(font).fontSize(size).currentLineHeight(true) + 2;
  }

  runs(runs: readonly Run[], area: Area, style: Style): void {
    const pieces = runs
      .map((run) => ({
        run,
        text: run.break ? '\n' : toWinAnsi(run.text),
      }))
      .filter((piece) => piece.text.length > 0);
    if (pieces.length === 0) return;
    this.ensure(this.lineHeight(style.size));
    pieces.forEach(({ run, text }, index) => {
      const size = run.code ? style.size - 1 : style.size;
      const options: PDFKit.Mixins.TextOptions = {
        continued: index < pieces.length - 1,
        link: run.href ?? null,
        underline: Boolean(run.href),
        strike: Boolean(run.strike),
        lineGap: 2,
      };
      this.doc
        .font(fontFor({ ...run, bold: run.bold || style.bold }))
        .fontSize(size)
        .fillColor(run.href ? LINK : style.color);
      if (index === 0)
        this.doc.text(text, area.x, this.doc.y, {
          ...options,
          width: area.width,
          align: style.align ?? 'left',
        });
      else this.doc.text(text, options);
    });
    this.doc.fillColor(TEXT);
  }

  private gap(points: number): void {
    this.doc.y += points;
  }

  blocks(blocks: readonly Block[], area: Area, afterBlock?: () => void): void {
    for (const block of blocks) {
      this.block(block, area);
      afterBlock?.();
    }
  }

  private block(block: Block, area: Area): void {
    switch (block.type) {
      case 'heading': {
        const size = HEADING_SIZES[Math.min(block.depth, 6) - 1]!;
        this.gap(size * 0.4);
        // Keep a heading with at least two lines of what follows it.
        this.ensure(this.lineHeight(size) + 2 * this.lineHeight(BODY));
        this.runs(block.runs, area, { size, bold: true, color: area.color });
        this.gap(4);
        return;
      }
      case 'paragraph':
        this.runs(block.runs, area, { size: BODY, color: area.color });
        this.gap(6);
        return;
      case 'code':
        this.code(block.text, area);
        return;
      case 'quote': {
        const page = this.doc.page;
        const top = this.doc.y;
        this.blocks(block.blocks, { x: area.x + INDENT, width: area.width - INDENT, color: MUTED });
        if (this.doc.page === page)
          this.doc
            .moveTo(area.x + 4, top)
            .lineTo(area.x + 4, Math.max(top, this.doc.y - 6))
            .lineWidth(2)
            .strokeColor(RULE)
            .stroke();
        return;
      }
      case 'rule': {
        this.ensure(14);
        const y = this.doc.y + 5;
        this.doc
          .moveTo(area.x, y)
          .lineTo(area.x + area.width, y)
          .lineWidth(0.75)
          .strokeColor(RULE)
          .stroke();
        this.gap(14);
        return;
      }
      case 'table':
        this.table(block, area);
        return;
      case 'list':
        this.list(block, area);
        return;
    }
  }

  private list(block: Extract<Block, { type: 'list' }>, area: Area): void {
    const indent = block.ordered ? INDENT + 8 : INDENT;
    block.items.forEach((item, index) => {
      this.ensure(this.lineHeight(BODY));
      const y = this.doc.y;
      const marker = block.ordered ? `${block.start + index}.` : '\u2022';
      this.doc
        .font('Helvetica')
        .fontSize(BODY)
        .fillColor(area.color)
        .text(marker, area.x, y, { width: indent - 2, lineBreak: false });
      this.doc.y = y;
      const inner = { x: area.x + indent, width: area.width - indent, color: area.color };
      if (item.blocks.length === 0) this.gap(this.lineHeight(BODY));
      for (const [position, child] of item.blocks.entries()) {
        // Tight items keep their paragraphs close together.
        if (child.type === 'paragraph') {
          this.runs(child.runs, inner, { size: BODY, color: area.color });
          this.gap(position === item.blocks.length - 1 ? 3 : 4);
        } else this.block(child, inner);
      }
    });
    this.gap(3);
  }

  private code(text: string, area: Area): void {
    const pad = 6;
    const width = area.width - 2 * pad;
    this.doc.font('Courier').fontSize(CODE);
    this.gap(2);
    for (const raw of text.split('\n')) {
      const line = toWinAnsi(raw) || ' ';
      const height = this.doc.heightOfString(line, { width, lineGap: 1 }) + 2;
      this.ensure(height);
      const y = this.doc.y;
      this.doc.rect(area.x, y, area.width, height).fill('#f2f2f2');
      this.doc
        .fillColor(TEXT)
        .font('Courier')
        .fontSize(CODE)
        .text(line, area.x + pad, y + 1, { width, lineGap: 1 });
      this.doc.y = y + height;
    }
    this.gap(8);
  }

  private table(block: TableBlock, area: Area): void {
    const columns = block.header.length;
    if (columns === 0) return;
    const pad = 4;
    const texts = (row: Run[][]) => row.map((cell) => toWinAnsi(runsText(cell)));
    const header = texts(block.header);
    const rows = block.rows.map(texts);
    // Columns share the width by their longest text, within limits.
    const weights = header.map((text, column) =>
      Math.min(40, Math.max(4, text.length, ...rows.map((row) => (row[column] ?? '').length))),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => (area.width * weight) / total);
    const maxRowHeight = (this.bottom - this.doc.page.margins.top) / 3;

    const measure = (row: string[], bold: boolean) => {
      this.doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE);
      const tallest = Math.max(
        ...row.map((text, column) =>
          this.doc.heightOfString(text || ' ', { width: widths[column]! - 2 * pad }),
        ),
      );
      return Math.min(maxRowHeight, tallest + 2 * pad);
    };
    const draw = (row: string[], bold: boolean, height: number) => {
      const y = this.doc.y;
      let x = area.x;
      row.forEach((text, column) => {
        const width = widths[column]!;
        if (bold) this.doc.rect(x, y, width, height).fill('#e7e6e6');
        this.doc.rect(x, y, width, height).lineWidth(0.5).strokeColor(RULE).stroke();
        this.doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(TABLE)
          .fillColor(TEXT)
          .text(text, x + pad, y + pad, {
            width: width - 2 * pad,
            height: height - 2 * pad,
            ellipsis: true,
            align: alignOf(block.align[column] ?? null),
          });
        x += width;
      });
      this.doc.y = y + height;
    };

    const headerHeight = measure(header, true);
    this.ensure(headerHeight + (rows[0] ? measure(rows[0], false) : 0));
    draw(header, true, headerHeight);
    for (const row of rows) {
      const height = measure(row, false);
      if (this.doc.y + height > this.bottom) {
        this.doc.addPage();
        draw(header, true, headerHeight);
      }
      draw(row, false, height);
    }
    this.doc.x = area.x;
    this.gap(10);
  }
}

function alignOf(align: Align): 'left' | 'center' | 'right' {
  return align ?? 'left';
}

export async function renderPdf(model: DocumentModel, maxBytes: number): Promise<Uint8Array> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: toWinAnsi(model.title), Creator: 'Open Chat Interface' },
    compress: true,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);
    });
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  const writer = new PdfWriter(doc);
  const area = { x: MARGIN, width: doc.page.width - 2 * MARGIN, color: TEXT };
  writer.runs([{ text: model.title }], area, { size: 22, bold: true, color: TEXT });
  doc.y += 10;
  writer.blocks(model.blocks, area, () => {
    if (size > maxBytes) throw new TooLargeError();
  });
  doc.end();
  await finished;
  if (size > maxBytes) throw new TooLargeError();
  return new Uint8Array(Buffer.concat(chunks, size));
}
