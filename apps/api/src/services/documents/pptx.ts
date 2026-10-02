import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import PptxGenJS from 'pptxgenjs';
import { validationFailed } from '../../lib/errors.js';
import type { Block, DocumentModel, Run, TableBlock } from './model.js';
import { runsText } from './model.js';

/**
 * PPTX output with pptxgenjs (MIT), 16:9.
 *
 * A title slide, then one slide per top-level heading, or per second-level
 * heading when the content has a single top-level one (whose text then titles
 * the deck). Content before the first such heading gets a slide of its own.
 * Paragraphs and list items become bullets (numbered for ordered lists, with
 * nesting kept), deeper headings bold lines, code a monospace block, tables
 * slide tables with their header row. A slide that would overflow continues
 * on the next ("Title (continued)"); a table's rows are spread over as many
 * slides as needed, repeating the header. Table cells are shortened to 500
 * characters, since a slide cannot show more. A deck is at most 250 slides.
 */

const FONT = 'Calibri';
const CODE_FONT = 'Courier New';
const BODY_SIZE = 18;
const CODE_SIZE = 13;
const TABLE_SIZE = 12;
/** Body capacity in 18-point lines, and characters per line at each size. */
const BUDGET = 13;
const CHARS_PER_LINE = 90;
const CODE_CHARS_PER_LINE = 110;
const CODE_LINE_COST = 0.75;
const TABLE_CHARS = 150;
export const MAX_CELL_CHARS = 500;
const BODY = { x: 0.6, y: 1.45, w: 12.13, h: 5.65 };
const MAX_LEVEL = 5;
/** A longer deck is refused: DOCX or PDF suit content of that length. */
export const MAX_SLIDES = 250;

interface TextItem {
  kind: 'text';
  runs: Run[];
  level: number;
  bullet: 'bullet' | 'number' | false;
  /** For numbered items: the list it belongs to and its number. */
  list?: number;
  number?: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface TableItem {
  kind: 'table';
  table: TableBlock;
}

type Item = TextItem | TableItem;

export interface Section {
  title: string;
  blocks: Block[];
}

export interface Slide {
  title: string;
  items: TextItem[];
  table?: { header: string[]; rows: string[][]; align: TableBlock['align'] };
}

/** Splits the content into slide sections and picks the deck's title. */
export function sections(model: DocumentModel): { deckTitle: string; sections: Section[] } {
  const headings = model.blocks.filter(
    (block): block is Extract<Block, { type: 'heading' }> => block.type === 'heading',
  );
  if (headings.length === 0)
    return {
      deckTitle: model.title,
      sections: model.blocks.length > 0 ? [{ title: model.title, blocks: model.blocks }] : [],
    };
  const top = Math.min(...headings.map((heading) => heading.depth));
  const tops = headings.filter((heading) => heading.depth === top);
  const deeper = headings.filter((heading) => heading.depth > top);
  let split = top;
  let deckTitle = model.title;
  let consumed: Block | null = null;
  if (tops.length === 1 && deeper.length > 0) {
    split = Math.min(...deeper.map((heading) => heading.depth));
    consumed = tops[0]!;
    deckTitle = runsText(tops[0]!.runs).trim() || model.title;
  }
  const result: Section[] = [];
  let current: Section | null = null;
  for (const block of model.blocks) {
    if (block === consumed) continue;
    if (block.type === 'heading' && block.depth <= split) {
      current = { title: runsText(block.runs).trim() || deckTitle, blocks: [] };
      result.push(current);
    } else {
      if (!current) {
        current = { title: deckTitle, blocks: [] };
        result.push(current);
      }
      current.blocks.push(block);
    }
  }
  return { deckTitle, sections: result };
}

function textLength(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + (run.break ? CHARS_PER_LINE / 2 : run.text.length), 0);
}

function cost(item: TextItem): number {
  if (item.code)
    return Math.max(1, Math.ceil(textLength(item.runs) / CODE_CHARS_PER_LINE)) * CODE_LINE_COST;
  const perLine = CHARS_PER_LINE - item.level * 6;
  return Math.max(1, Math.ceil(textLength(item.runs) / perLine)) + 0.25;
}

/** Cuts runs into pieces of at most `limit` characters, at spaces where possible. */
export function splitRuns(runs: readonly Run[], limit: number): Run[][] {
  const pieces: Run[][] = [];
  let piece: Run[] = [];
  let length = 0;
  for (const run of runs) {
    let text = run.text;
    if (run.break) {
      piece.push(run);
      continue;
    }
    while (length + text.length > limit) {
      const room = limit - length;
      const space = text.lastIndexOf(' ', room);
      const cut = space > room / 2 ? space + 1 : Math.max(1, room);
      piece.push({ ...run, text: text.slice(0, cut) });
      pieces.push(piece);
      piece = [];
      length = 0;
      text = text.slice(cut);
    }
    if (text) {
      piece.push({ ...run, text });
      length += text.length;
    }
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

class ItemBuilder {
  readonly items: Item[] = [];
  private lists = 0;

  blocks(blocks: readonly Block[], level: number, italic: boolean): void {
    for (const block of blocks) this.block(block, level, italic);
  }

  private text(item: TextItem): void {
    const limit = Math.floor(
      (item.code ? CODE_CHARS_PER_LINE : CHARS_PER_LINE - item.level * 6) * (BUDGET - 1),
    );
    splitRuns(item.runs, limit).forEach((runs, index) => {
      // Only the first piece of a split item carries its bullet.
      this.items.push({ ...item, runs, ...(index > 0 ? { bullet: false } : {}) });
    });
  }

  private block(block: Block, level: number, italic: boolean): void {
    switch (block.type) {
      case 'heading':
        this.text({ kind: 'text', runs: block.runs, level, bullet: false, bold: true, italic });
        return;
      case 'paragraph':
        this.text({ kind: 'text', runs: block.runs, level, bullet: 'bullet', italic });
        return;
      case 'code':
        for (const line of block.text.split('\n'))
          this.text({
            kind: 'text',
            runs: [{ text: line || ' ' }],
            level,
            bullet: false,
            code: true,
          });
        return;
      case 'quote':
        this.blocks(block.blocks, level, true);
        return;
      case 'rule':
        return;
      case 'table':
        this.items.push({ kind: 'table', table: block });
        return;
      case 'list': {
        const list = ++this.lists;
        block.items.forEach((entry, index) => {
          const [first, ...rest] = entry.blocks;
          const marker: TextItem = {
            kind: 'text',
            runs: first?.type === 'paragraph' ? first.runs : [{ text: ' ' }],
            level,
            bullet: block.ordered ? 'number' : 'bullet',
            italic,
            ...(block.ordered ? { list, number: block.start + index } : {}),
          };
          this.text(marker);
          this.blocks(
            first?.type === 'paragraph' ? rest : entry.blocks,
            Math.min(level + 1, MAX_LEVEL),
            italic,
          );
        });
        return;
      }
    }
  }
}

function cellText(runs: readonly Run[]): string {
  const text = runsText(runs).replace(/\s+/g, ' ').trim();
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}\u2026` : text;
}

function rowCost(row: readonly string[]): number {
  const perCell = Math.max(8, Math.floor(TABLE_CHARS / Math.max(1, row.length)));
  return Math.max(1, ...row.map((text) => Math.ceil(text.length / perCell))) * 0.8 + 0.2;
}

/** Lays sections out as slides, continuing any that overflow. */
export function paginate(section: Section): Slide[] {
  const builder = new ItemBuilder();
  builder.blocks(section.blocks, 0, false);
  const slides: Slide[] = [];
  let slide: Slide | null = null;
  let used = 0;
  const title = () => (slides.length === 0 ? section.title : `${section.title} (continued)`);
  const fresh = (): Slide => {
    const next: Slide = { title: title(), items: [] };
    slides.push(next);
    used = 0;
    return next;
  };

  for (const item of builder.items) {
    if (item.kind === 'table') {
      const header = item.table.header.map(cellText);
      const rows = item.table.rows.map((row) => row.map(cellText));
      const headerCost = rowCost(header);
      let chunk: string[][] = [];
      let chunkCost = headerCost;
      const flush = () => {
        const target = slide && slide.items.length === 0 && !slide.table ? slide : fresh();
        target.table = { header, rows: chunk, align: item.table.align };
        slide = null;
        chunk = [];
        chunkCost = headerCost;
      };
      for (const row of rows) {
        const cost = rowCost(row);
        if (chunk.length > 0 && chunkCost + cost > BUDGET) flush();
        chunk.push(row);
        chunkCost += cost;
      }
      flush();
      continue;
    }
    const itemCost = cost(item);
    if (!slide || slide.table || (used > 0 && used + itemCost > BUDGET)) slide = fresh();
    slide.items.push(item);
    used += itemCost;
  }
  if (slides.length === 0) fresh();
  return slides;
}

function textProps(items: readonly TextItem[]): PptxGenJS.TextProps[] {
  const props: PptxGenJS.TextProps[] = [];
  let numbering: { list: number; level: number; startAt: number } | null = null;
  for (const item of items) {
    let bullet: PptxGenJS.TextPropsOptions['bullet'] = false;
    if (item.bullet === 'bullet') bullet = true;
    else if (item.bullet === 'number') {
      // Items of one list on one slide continue from the first one's number.
      if (!numbering || numbering.list !== item.list || numbering.level !== item.level)
        numbering = { list: item.list!, level: item.level, startAt: item.number! };
      bullet = { type: 'number', numberStartAt: numbering.startAt };
    }
    const runs = item.runs.length > 0 ? item.runs : [{ text: ' ' }];
    runs.forEach((run, index) => {
      const options: PptxGenJS.TextPropsOptions = {
        fontFace: item.code || run.code ? CODE_FONT : FONT,
        fontSize: item.code ? CODE_SIZE : BODY_SIZE,
        ...(item.bold || run.bold ? { bold: true } : {}),
        ...(item.italic || run.italic ? { italic: true } : {}),
        ...(run.strike ? { strike: 'sngStrike' as const } : {}),
        ...(run.href ? { hyperlink: { url: run.href } } : {}),
        ...(index > 0 && runs[index - 1]?.break ? { softBreakBefore: true } : {}),
      };
      if (index === 0) {
        options.bullet = bullet;
        if (item.level > 0) options.indentLevel = item.level;
        options.paraSpaceAfter = item.code ? 0 : 4;
      }
      if (index === runs.length - 1) options.breakLine = true;
      props.push({ text: run.break ? '' : run.text, options });
    });
  }
  return props;
}

export async function renderPptx(model: DocumentModel): Promise<Uint8Array> {
  const deck = sections(model);
  const laidOut = deck.sections.map((section) => paginate(section));
  const count = 1 + laidOut.reduce((sum, slides) => sum + slides.length, 0);
  if (count > MAX_SLIDES)
    throw validationFailed(
      `This content needs ${count} slides; a presentation can have at most ${MAX_SLIDES}. ` +
        'Export it as DOCX or PDF instead.',
    );
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = model.title;
  pptx.author = 'Open Chat Interface';
  pptx.company = '';

  const cover = pptx.addSlide();
  cover.addText(deck.deckTitle, {
    x: 0.6,
    y: 2.4,
    w: 12.13,
    h: 1.6,
    fontFace: FONT,
    fontSize: 36,
    bold: true,
    align: 'center',
    valign: 'middle',
    fit: 'shrink',
  });
  if (deck.deckTitle !== model.title)
    cover.addText(model.title, {
      x: 0.6,
      y: 4.1,
      w: 12.13,
      h: 0.8,
      fontFace: FONT,
      fontSize: 20,
      color: '595959',
      align: 'center',
    });

  for (const slides of laidOut) {
    for (const slide of slides) {
      const page = pptx.addSlide();
      page.addText(slide.title, {
        x: 0.5,
        y: 0.35,
        w: 12.33,
        h: 0.9,
        fontFace: FONT,
        fontSize: 28,
        bold: true,
        valign: 'top',
        fit: 'shrink',
      });
      if (slide.items.length > 0)
        page.addText(textProps(slide.items), { ...BODY, valign: 'top', fontFace: FONT });
      if (slide.table) {
        const { header, rows, align } = slide.table;
        const cell = (text: string, column: number, head: boolean): PptxGenJS.TableCell => ({
          text,
          options: {
            ...(head ? { bold: true, fill: { color: 'E7E6E6' } } : {}),
            align: align[column] ?? 'left',
          },
        });
        page.addTable(
          [
            header.map((text, column) => cell(text, column, true)),
            ...rows.map((row) => row.map((text, column) => cell(text, column, false))),
          ],
          {
            ...BODY,
            h: undefined,
            fontFace: FONT,
            fontSize: TABLE_SIZE,
            border: { type: 'solid', pt: 0.5, color: 'BFBFBF' },
            valign: 'top',
          },
        );
      }
    }
  }

  const output = await pptx.write({ outputType: 'nodebuffer', compression: false });
  return repairParagraphProperties(new Uint8Array(output as Uint8Array));
}

/** A paragraph-properties element anywhere but first in its paragraph. */
const STRAY_PARAGRAPH_PROPERTIES = /(?<!<a:p>)<a:pPr\b[^>]*?(?:\/>|>.*?<\/a:pPr>)/gs;

/**
 * pptxgenjs 4.0.1 writes an `a:pPr` before every run of a paragraph, not only
 * the first, which the schema forbids (PowerPoint offers to repair the file).
 * The paragraph's properties are the first one's, so the others are removed.
 */
export function repairParagraphProperties(file: Uint8Array): Uint8Array {
  const entries = unzipSync(file);
  for (const [name, content] of Object.entries(entries)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    entries[name] = strToU8(strFromU8(content).replace(STRAY_PARAGRAPH_PROPERTIES, ''));
  }
  return zipSync(entries, { level: 6 });
}
