import MarkdownItFactory, { type MarkdownIt, type Token } from 'markdown-it';

/**
 * The document model every file generator reads (v0.9 file output).
 *
 * Markdown is parsed once, with markdown-it (CommonMark plus GFM tables and
 * strikethrough, and bare links), into this small model, so the DOCX, PDF,
 * XLSX and PPTX writers agree on what a reply contains and none of them sees
 * Markdown syntax. markdown-it rather than micromark: micromark's GFM table
 * and emphasis handling is quadratic (a 40,000-row table took over a minute),
 * while markdown-it stays linear on the same inputs and caps nesting.
 *
 * Everything is text: raw HTML is kept as literal text, images become their
 * alternative text ("[Image: alt]") and are never fetched, and math stays as
 * written. Only http, https and mailto links survive as links.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** A safe http(s) or mailto address; other links are plain text. */
  href?: string;
  /** A hard line break (the text is empty). */
  break?: boolean;
}

export type Align = 'left' | 'center' | 'right' | null;

export interface TableBlock {
  type: 'table';
  align: Align[];
  header: Run[][];
  rows: Run[][][];
}

export type Block =
  | { type: 'heading'; depth: number; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'quote'; blocks: Block[] }
  | TableBlock
  | { type: 'rule' };

export interface ListItem {
  blocks: Block[];
}

export interface DocumentModel {
  title: string;
  blocks: Block[];
}

/**
 * markdown-it's nesting limit (its default). Each list, item, quote and
 * paragraph is a level, so about 30 nested lists or 50 nested quotes fit;
 * markdown-it drops anything nested deeper rather than recursing.
 */
const MAX_NESTING = 100;

let parser: MarkdownIt | null = null;
function markdown(): MarkdownIt {
  parser ??= new MarkdownItFactory('default', {
    html: false,
    linkify: true,
    typographer: false,
    maxNesting: MAX_NESTING,
  });
  return parser;
}

/** Characters XML 1.0 cannot carry (and lone surrogates), removed from all input. */
const INVALID_XML =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(INVALID_XML, '');
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** The address when it is an absolute http(s) or mailto link, otherwise undefined. */
export function safeHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!SAFE_LINK.test(trimmed) || trimmed.length > 2048) return undefined;
  try {
    return new URL(trimmed).href;
  } catch {
    return undefined;
  }
}

function sameMarks(a: Run, b: Run): boolean {
  return (
    !a.break &&
    !b.break &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.strike === b.strike &&
    a.href === b.href
  );
}

function pushRun(runs: Run[], run: Run): void {
  if (!run.break && !run.text) return;
  const last = runs.at(-1);
  if (last && sameMarks(last, run)) last.text += run.text;
  else runs.push(run);
}

/** Inline tokens to styled runs. Soft breaks read as spaces, as they render. */
function inlineRuns(children: Token[] | null): Run[] {
  const runs: Run[] = [];
  let bold = 0;
  let italic = 0;
  let strike = 0;
  const links: Array<string | undefined> = [];
  const marks = () => {
    const href = links.at(-1);
    return {
      ...(bold > 0 ? { bold: true } : {}),
      ...(italic > 0 ? { italic: true } : {}),
      ...(strike > 0 ? { strike: true } : {}),
      ...(href ? { href } : {}),
    };
  };
  for (const token of children ?? []) {
    switch (token.type) {
      case 'strong_open':
        bold++;
        break;
      case 'strong_close':
        bold = Math.max(0, bold - 1);
        break;
      case 'em_open':
        italic++;
        break;
      case 'em_close':
        italic = Math.max(0, italic - 1);
        break;
      case 's_open':
        strike++;
        break;
      case 's_close':
        strike = Math.max(0, strike - 1);
        break;
      case 'link_open':
        links.push(safeHref(String(token.attrGet('href') ?? '')));
        break;
      case 'link_close':
        links.pop();
        break;
      case 'code_inline':
        pushRun(runs, { text: token.content, ...marks(), code: true });
        break;
      case 'softbreak':
        pushRun(runs, { text: ' ', ...marks() });
        break;
      case 'hardbreak':
        runs.push({ text: '', break: true });
        break;
      case 'image': {
        const alt = (token.children ?? [])
          .map((child: Token) => child.content)
          .join('')
          .trim();
        pushRun(runs, { text: alt ? `[Image: ${alt}]` : '[Image]', ...marks() });
        break;
      }
      default:
        // text, text_special and anything unexpected: its literal content.
        if (token.content) pushRun(runs, { text: token.content, ...marks() });
    }
  }
  return runs;
}

type Frame =
  | { kind: 'root' | 'item' | 'quote'; blocks: Block[] }
  | { kind: 'list'; items: ListItem[] };

function alignOf(token: Token): Align {
  const style = String(token.attrGet('style') ?? '');
  const match = /text-align:\s*(left|center|right)/.exec(style);
  return (match?.[1] as Align) ?? null;
}

function parseTable(tokens: Token[], start: number): { table: TableBlock; end: number } {
  const table: TableBlock = { type: 'table', align: [], header: [], rows: [] };
  let row: Run[][] | null = null;
  let inHead = false;
  let index = start + 1;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'table_close') break;
    if (token.type === 'thead_open') inHead = true;
    else if (token.type === 'thead_close') inHead = false;
    else if (token.type === 'tr_open') row = [];
    else if (token.type === 'tr_close' && row) {
      if (inHead) table.header = row;
      else table.rows.push(row);
      row = null;
    } else if (token.type === 'th_open' && inHead) table.align.push(alignOf(token));
    else if (token.type === 'inline' && row) row.push(inlineRuns(token.children));
  }
  // Rows are padded or cut to the header's width, as GFM renders them.
  const width = table.header.length;
  table.rows = table.rows.map((cells) =>
    Array.from({ length: width }, (_, column) => cells[column] ?? []),
  );
  return { table, end: index };
}

/** Parses Markdown into the document model. Never throws on any string. */
export function parseMarkdown(source: string): Block[] {
  const tokens = markdown().parse(cleanText(source), {});
  const root: Block[] = [];
  const stack: Frame[] = [{ kind: 'root', blocks: root }];
  /** The blocks new content goes into; content directly in a list gets an item. */
  const current = (): Block[] => {
    const top = stack.at(-1)!;
    if (top.kind !== 'list') return top.blocks;
    const item: ListItem = { blocks: [] };
    top.items.push(item);
    stack.push({ kind: 'item', blocks: item.blocks });
    return item.blocks;
  };
  /** Closes the innermost open container of `kind` (never the root). */
  const close = (kind: Frame['kind']) => {
    if (!stack.some((frame) => frame.kind === kind)) return;
    while (stack.length > 1 && stack.pop()!.kind !== kind) {
      // Unwind any container left open inside it.
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[index + 1];
        current().push({
          type: 'heading',
          depth: Number(token.tag.slice(1)) || 1,
          runs: inlineRuns(inline?.type === 'inline' ? inline.children : null),
        });
        index += 2;
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[index + 1];
        const runs = inlineRuns(inline?.type === 'inline' ? inline.children : null);
        if (runs.length > 0) current().push({ type: 'paragraph', runs });
        index += 2;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const start = Number(token.attrGet('start') ?? 1);
        const items: ListItem[] = [];
        current().push({
          type: 'list',
          ordered: token.type === 'ordered_list_open',
          start: Number.isSafeInteger(start) && start >= 0 ? start : 1,
          items,
        });
        stack.push({ kind: 'list', items });
        break;
      }
      case 'list_item_open': {
        let top = stack.at(-1)!;
        if (top.kind !== 'list') {
          const items: ListItem[] = [];
          current().push({ type: 'list', ordered: false, start: 1, items });
          top = { kind: 'list', items };
          stack.push(top);
        }
        const item: ListItem = { blocks: [] };
        top.items.push(item);
        stack.push({ kind: 'item', blocks: item.blocks });
        break;
      }
      case 'blockquote_open': {
        const blocks: Block[] = [];
        current().push({ type: 'quote', blocks });
        stack.push({ kind: 'quote', blocks });
        break;
      }
      case 'list_item_close':
        close('item');
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        close('list');
        break;
      case 'blockquote_close':
        close('quote');
        break;
      case 'fence':
      case 'code_block': {
        const lang = token.type === 'fence' ? token.info.trim().split(/\s+/)[0] || null : null;
        current().push({ type: 'code', lang, text: token.content.replace(/\n$/, '') });
        break;
      }
      case 'hr':
        current().push({ type: 'rule' });
        break;
      case 'table_open': {
        const { table, end } = parseTable(tokens, index);
        current().push(table);
        index = end;
        break;
      }
      default:
        if (token.type === 'inline' && token.content)
          current().push({ type: 'paragraph', runs: inlineRuns(token.children) });
    }
  }
  return root;
}

export function documentModel(title: string, markdownSource: string): DocumentModel {
  return {
    title: cleanText(title).trim() || 'Untitled',
    blocks: parseMarkdown(markdownSource),
  };
}

/** The runs as plain text; a hard break is a newline. */
export function runsText(runs: readonly Run[]): string {
  return runs.map((run) => (run.break ? '\n' : run.text)).join('');
}

/** Every table in document order (also inside lists and quotes), with the heading above it. */
export function collectTables(
  blocks: readonly Block[],
): Array<{ table: TableBlock; heading: string | null }> {
  const found: Array<{ table: TableBlock; heading: string | null }> = [];
  let heading: string | null = null;
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'heading') heading = runsText(block.runs).trim() || heading;
      else if (block.type === 'table') found.push({ table: block, heading });
      else if (block.type === 'quote') visit(block.blocks);
      else if (block.type === 'list') for (const item of block.items) visit(item.blocks);
    }
  };
  visit(blocks);
  return found;
}

/** Whether the content has at least one table with a header. */
export function hasTables(blocks: readonly Block[]): boolean {
  return collectTables(blocks).length > 0;
}
