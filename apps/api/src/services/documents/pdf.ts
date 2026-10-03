import PDFDocument from 'pdfkit';
import type { Align, Block, DocumentModel, Run, TableBlock } from './model.js';
import { runsText } from './model.js';
import {
  cjkOrder,
  FontBook,
  needsUnicodeFonts,
  type Span,
  TextEngine,
  type TextLine,
} from './pdf-text.js';
import { toWinAnsi } from './pdf-winansi.js';

export { toWinAnsi };

/**
 * PDF output with pdfkit (MIT), laid out here without a browser: A4, 2 cm
 * margins.
 *
 * A document whose text fits Windows-1252 (Western European) uses the PDF
 * standard fonts Helvetica and Courier, which are not embedded, as before
 * v0.10; a few symbols get ASCII stand-ins ("→" → "->"). Any other document
 * (v0.10) embeds Noto fonts for every script it uses, chosen per run of
 * characters, with right-to-left paragraphs laid out by the Unicode
 * Bidirectional Algorithm: see pdf-text.ts. Should the font packages be
 * missing (they are optional), such a document falls back to the standard
 * fonts, where characters outside Windows-1252 print as "?".
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

/** Every piece of text in a document, to decide which fonts it needs. */
function documentText(model: DocumentModel): string {
  const parts: string[] = [model.title];
  const visit = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          parts.push(runsText(block.runs));
          break;
        case 'code':
          parts.push(block.text);
          break;
        case 'quote':
          visit(block.blocks);
          break;
        case 'list':
          for (const item of block.items) visit(item.blocks);
          break;
        case 'table':
          for (const row of [block.header, ...block.rows])
            for (const cell of row) parts.push(runsText(cell));
          break;
        case 'rule':
          break;
      }
    }
  };
  visit(model.blocks);
  return parts.join('\n');
}

class PdfWriter {
  constructor(
    private readonly doc: Doc,
    /** Embedded fonts for every script; null: the standard fonts only. */
    private readonly text: TextEngine | null = null,
  ) {}

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

  /** Draws laid-out lines from the current position, breaking pages between lines. */
  private lines(lines: readonly TextLine[], area: Area, align: Style['align']): void {
    for (const line of lines) {
      this.ensure(line.height);
      const y = this.doc.y;
      this.text!.drawLine(line, area.x, area.width, y, align ?? 'start');
      this.doc.y = y + line.height;
    }
    this.doc.x = area.x;
  }

  private spans(runs: readonly Run[], style: Style, size = style.size): Span[] {
    return runs.map((run) => ({
      text: run.break ? '\n' : run.text,
      size: run.code ? size - 1 : size,
      color: style.color,
      bold: run.bold || style.bold,
      italic: run.italic,
      code: run.code,
      href: run.href ?? null,
      strike: run.strike,
    }));
  }

  runs(runs: readonly Run[], area: Area, style: Style): void {
    if (this.text) {
      if (!runs.some((run) => run.break || run.text.length > 0)) return;
      const lines = this.text.layout(this.spans(runs, style), area.width);
      this.lines(lines, area, style.align);
      return;
    }
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
    if (this.text) {
      for (const raw of text.split('\n')) {
        const span = { text: raw || ' ', size: CODE, color: TEXT, code: true };
        for (const line of this.text.layout([span], width, 'ltr')) {
          this.ensure(line.height);
          const y = this.doc.y;
          this.doc.rect(area.x, y, area.width, line.height).fill('#f2f2f2');
          this.text.drawLine(line, area.x + pad, width, y + 1, 'left');
          this.doc.y = y + line.height;
        }
      }
      this.doc.x = area.x;
      this.gap(8);
      return;
    }
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

    if (this.text) {
      this.unicodeTable(block, area, widths, pad, maxRowHeight);
      return;
    }

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

  private unicodeTable(
    block: TableBlock,
    area: Area,
    widths: number[],
    pad: number,
    maxRowHeight: number,
  ): void {
    const engine = this.text!;
    const layoutRow = (row: Run[][], bold: boolean) => {
      const cells = widths.map((width, column) =>
        cellLines(engine, row[column] ?? [], width - 2 * pad, bold),
      );
      const tallest = Math.max(
        ...cells.map((lines) => lines.reduce((sum, line) => sum + line.height, 0)),
      );
      return { cells, height: Math.min(maxRowHeight, tallest + 2 * pad) };
    };
    const draw = (row: ReturnType<typeof layoutRow>, bold: boolean) => {
      const y = this.doc.y;
      let x = area.x;
      row.cells.forEach((lines, column) => {
        const width = widths[column]!;
        if (bold) this.doc.rect(x, y, width, row.height).fill('#e7e6e6');
        this.doc.rect(x, y, width, row.height).lineWidth(0.5).strokeColor(RULE).stroke();
        let top = y + pad;
        for (const line of lines) {
          // Cut at the row's height, as the standard-font table does.
          if (top + line.height > y + row.height - pad + 0.01) break;
          engine.drawLine(
            line,
            x + pad,
            width - 2 * pad,
            top,
            alignOf(block.align[column] ?? null, true),
          );
          top += line.height;
        }
        x += width;
      });
      this.doc.y = y + row.height;
    };
    const header = layoutRow(block.header, true);
    const rows = block.rows.map((row) => layoutRow(row, false));
    this.ensure(header.height + (rows[0]?.height ?? 0));
    draw(header, true);
    for (const row of rows) {
      if (this.doc.y + row.height > this.bottom) {
        this.doc.addPage();
        draw(header, true);
      }
      draw(row, false);
    }
    this.doc.x = area.x;
    this.gap(10);
  }
}

/** Table cells in any script: laid out per cell, cut at the row's height. */
function cellLines(engine: TextEngine, cell: Run[], width: number, bold: boolean): TextLine[] {
  const spans = cell.map((run) => ({
    text: run.break ? ' ' : run.text,
    size: TABLE,
    color: TEXT,
    bold: run.bold || bold,
    italic: run.italic,
    code: run.code,
    href: run.href ?? null,
    strike: run.strike,
  }));
  return engine.layout(spans.length ? spans : [{ text: ' ', size: TABLE, color: TEXT }], width);
}

function alignOf(align: Align): 'left' | 'center' | 'right';
function alignOf(align: Align, start: true): 'start' | 'left' | 'center' | 'right';
function alignOf(align: Align, start = false): 'start' | 'left' | 'center' | 'right' {
  return align ?? (start ? 'start' : 'left');
}

export async function renderPdf(model: DocumentModel, maxBytes: number): Promise<Uint8Array> {
  const text = documentText(model);
  const unicode = needsUnicodeFonts(text);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: unicode ? model.title : toWinAnsi(model.title),
      Creator: unicode ? model.creator : toWinAnsi(model.creator),
    },
    compress: true,
  });
  // The fonts are read only for a document that needs them.
  const fonts = unicode ? new FontBook(doc, cjkOrder(text)) : null;
  const engine = fonts?.available ? new TextEngine(doc, fonts) : null;
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

  const writer = new PdfWriter(doc, engine);
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
