import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  type ILevelsOptions,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { Align, Block, DocumentModel, Run, TableBlock } from './model.js';

/**
 * DOCX output with the `docx` library (MIT): the title as the Title style,
 * headings as Heading 1–6, real Word lists (bullets, and numbering that keeps
 * each list's start), tables with a repeated, shaded header row, code in a
 * monospace font. A4 with 2.5 cm margins.
 */

const CODE_FONT = 'Courier New';
const CODE_SHADING = { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' } as const;
/** A4 in twentieths of a point, and the text width inside 2.54 cm margins. */
const PAGE = { width: 11906, height: 16838, margin: 1440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
const INDENT = 360;
const MAX_LEVEL = 8;
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;
const BULLETS = ['\u2022', '\u25e6', '\u25aa'];

interface Context {
  /** Left indent in twips for content that is not itself a list paragraph. */
  indent: number;
  /** Nesting level of the next list (0 for a top-level list). */
  level: number;
  quote: boolean;
}

function levels(ordered: boolean, start: number): ILevelsOptions[] {
  return Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : BULLETS[level % BULLETS.length],
    alignment: AlignmentType.LEFT,
    ...(ordered ? { start } : {}),
    style: { paragraph: { indent: { left: INDENT * (level + 2), hanging: INDENT } } },
  }));
}

function alignment(align: Align) {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

function textRun(run: Run, extra: { bold?: boolean; color?: string } = {}): TextRun {
  if (run.break) return new TextRun({ break: 1 });
  return new TextRun({
    text: run.text,
    bold: run.bold || extra.bold || undefined,
    italics: run.italic || undefined,
    strike: run.strike || undefined,
    ...(run.code ? { font: CODE_FONT, shading: CODE_SHADING } : {}),
    ...(run.href ? { style: 'Hyperlink' } : {}),
    ...(extra.color && !run.href ? { color: extra.color } : {}),
  });
}

/** Runs to paragraph children; consecutive runs with the same link share one hyperlink. */
function children(runs: readonly Run[], extra: { bold?: boolean; color?: string } = {}) {
  const result: ParagraphChild[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (!run.href) {
      result.push(textRun(run, extra));
      continue;
    }
    const linked: TextRun[] = [];
    while (index < runs.length && runs[index]!.href === run.href) {
      linked.push(textRun(runs[index]!, extra));
      index++;
    }
    index--;
    result.push(new ExternalHyperlink({ link: run.href, children: linked }));
  }
  return result;
}

const QUOTE_BORDER = {
  left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 },
} as const;

function paragraphOptions(context: Context) {
  return {
    ...(context.indent > 0 ? { indent: { left: context.indent } } : {}),
    ...(context.quote ? { border: QUOTE_BORDER } : {}),
  };
}

class DocxBuilder {
  /** One numbering definition per ordered list, so each restarts at its own start. */
  readonly numbering: Array<{ reference: string; levels: ILevelsOptions[] }> = [
    { reference: 'oci-bullets', levels: levels(false, 1) },
  ];

  blocks(blocks: readonly Block[], context: Context): Array<Paragraph | Table> {
    return blocks.flatMap((block) => this.block(block, context));
  }

  private block(block: Block, context: Context): Array<Paragraph | Table> {
    const color = context.quote ? '595959' : undefined;
    switch (block.type) {
      case 'heading':
        // Inside lists and quotes a heading keeps the indent and reads as bold text.
        if (context.indent > 0 || context.quote)
          return [
            new Paragraph({
              children: children(block.runs, { bold: true, color }),
              ...paragraphOptions(context),
            }),
          ];
        return [
          new Paragraph({
            heading: HEADINGS[Math.min(block.depth, 6) - 1],
            children: children(block.runs),
          }),
        ];
      case 'paragraph':
        return [
          new Paragraph({
            children: children(block.runs, { color }),
            ...paragraphOptions(context),
          }),
        ];
      case 'code': {
        const lines = block.text.split('\n');
        return [
          new Paragraph({
            shading: CODE_SHADING,
            ...paragraphOptions(context),
            children: lines.map(
              (line, index) =>
                new TextRun({ text: line, font: CODE_FONT, size: 19, break: index > 0 ? 1 : 0 }),
            ),
          }),
        ];
      }
      case 'quote':
        return this.blocks(block.blocks, {
          ...context,
          indent: context.indent + INDENT,
          quote: true,
        });
      case 'rule':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } },
            ...paragraphOptions(context),
          }),
        ];
      case 'table':
        return [this.table(block)];
      case 'list':
        return this.list(block, context);
    }
  }

  private list(
    block: Extract<Block, { type: 'list' }>,
    context: Context,
  ): Array<Paragraph | Table> {
    const level = Math.min(context.level, MAX_LEVEL);
    let reference = 'oci-bullets';
    if (block.ordered) {
      reference = `oci-ordered-${this.numbering.length}`;
      this.numbering.push({ reference, levels: levels(true, block.start) });
    }
    const inner: Context = {
      indent: INDENT * (level + 2),
      level: context.level + 1,
      quote: context.quote,
    };
    return block.items.flatMap((item) => {
      const [first, ...rest] = item.blocks;
      const marker = new Paragraph({
        numbering: { reference, level },
        ...(context.quote ? { border: QUOTE_BORDER } : {}),
        children:
          first?.type === 'paragraph'
            ? children(first.runs, { color: context.quote ? '595959' : undefined })
            : [],
      });
      const remaining = first?.type === 'paragraph' ? rest : item.blocks;
      return [marker, ...this.blocks(remaining, inner)];
    });
  }

  private table(block: TableBlock): Table {
    const columns = Math.max(1, block.header.length);
    const width = Math.floor(TEXT_WIDTH / columns);
    const cell = (runs: Run[], column: number, header: boolean) =>
      new TableCell({
        width: { size: width, type: WidthType.DXA },
        ...(header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E7E6E6' } } : {}),
        children: [
          new Paragraph({
            alignment: alignment(block.align[column] ?? null),
            children: children(runs, { bold: header }),
          }),
        ],
      });
    return new Table({
      width: { size: width * columns, type: WidthType.DXA },
      columnWidths: Array.from({ length: columns }, () => width),
      rows: [
        new TableRow({
          tableHeader: true,
          children: block.header.map((runs, column) => cell(runs, column, true)),
        }),
        ...block.rows.map(
          (row) => new TableRow({ children: row.map((runs, column) => cell(runs, column, false)) }),
        ),
      ],
    });
  }
}

export async function renderDocx(model: DocumentModel): Promise<Uint8Array> {
  const builder = new DocxBuilder();
  const body = builder.blocks(model.blocks, { indent: 0, level: 0, quote: false });
  const document = new Document({
    title: model.title,
    creator: model.creator,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: builder.numbering },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: {
              top: PAGE.margin,
              right: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
            },
          },
        },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.title)] }),
          ...body,
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
