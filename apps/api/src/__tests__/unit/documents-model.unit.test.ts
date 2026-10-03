import { markdownHasTable } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  type Block,
  cleanText,
  collectTables,
  documentModel,
  hasTables,
  parseMarkdown,
  runsText,
  safeHref,
} from '../../services/documents/model.js';

/** The file-output document model: what every generator reads (v0.9). */

const textOf = (block: Block | undefined) =>
  runsText((block as Extract<Block, { type: 'paragraph' }>).runs);
const only = <T extends Block['type']>(blocks: Block[], type: T) =>
  blocks.filter((block): block is Extract<Block, { type: T }> => block.type === type);

describe('document model: blocks', () => {
  it('reads headings, paragraphs, code, quotes and rules', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '## Second',
        '###### Sixth',
        '',
        'A paragraph',
        'continued on a second line.',
        '',
        '```ts',
        'const a = 1;',
        '  indented();',
        '```',
        '',
        '    indented code',
        '',
        '> quoted **text**',
        '> > nested',
        '',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'heading',
      'heading',
      'paragraph',
      'code',
      'code',
      'quote',
      'rule',
    ]);
    expect(only(blocks, 'heading').map((block) => block.depth)).toEqual([1, 2, 6]);
    // Soft line breaks read as spaces, as they render.
    expect(runsText(only(blocks, 'paragraph')[0]!.runs)).toBe(
      'A paragraph continued on a second line.',
    );
    const [fenced, indented] = only(blocks, 'code');
    expect(fenced).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1;\n  indented();' });
    expect(indented).toEqual({ type: 'code', lang: null, text: 'indented code' });
    const quote = only(blocks, 'quote')[0]!;
    expect(quote.blocks[0]).toMatchObject({ type: 'paragraph' });
    expect(quote.blocks[1]).toMatchObject({ type: 'quote' });
  });

  it('keeps nested lists, ordered starts and multi-paragraph items', () => {
    const [list, ordered] = parseMarkdown(
      [
        '- one',
        '  - nested',
        '    1. deep',
        '    2. deeper',
        '- two',
        '',
        '  second paragraph of two',
        '',
        'text',
        '',
        '7. seven',
        '8. eight',
      ].join('\n'),
    ).filter((block) => block.type === 'list') as Array<Extract<Block, { type: 'list' }>>;
    expect(list).toMatchObject({ ordered: false, start: 1 });
    expect(list!.items).toHaveLength(2);
    const nested = list!.items[0]!.blocks[1] as Extract<Block, { type: 'list' }>;
    expect(nested.type).toBe('list');
    const deep = nested.items[0]!.blocks[1] as Extract<Block, { type: 'list' }>;
    expect(deep).toMatchObject({ type: 'list', ordered: true, start: 1 });
    expect(deep.items.map((item) => textOf(item.blocks[0]))).toEqual(['deep', 'deeper']);
    expect(list!.items[1]!.blocks).toHaveLength(2);
    expect(ordered).toMatchObject({ ordered: true, start: 7 });
  });

  it('reads GFM tables with alignment, padding short rows and cutting long ones', () => {
    const [table] = parseMarkdown(
      ['| Name | Qty | Note |', '| :--- | ---: | :-: |', '| a | 1 |', '| b | 2 | x | extra |'].join(
        '\n',
      ),
    );
    expect(table).toMatchObject({ type: 'table', align: ['left', 'right', 'center'] });
    const { header, rows } = table as Extract<Block, { type: 'table' }>;
    expect(header.map(runsText)).toEqual(['Name', 'Qty', 'Note']);
    expect(rows.map((row) => row.map(runsText))).toEqual([
      ['a', '1', ''],
      ['b', '2', 'x'],
    ]);
  });

  it('finds tables inside lists and quotes, named by the heading above them', () => {
    const blocks = parseMarkdown(
      [
        '| a |',
        '|---|',
        '| 1 |',
        '',
        '## Sales',
        '',
        '- item',
        '',
        '  | b |',
        '  |---|',
        '  | 2 |',
        '',
        '> | c |',
        '> |---|',
        '> | 3 |',
      ].join('\n'),
    );
    expect(collectTables(blocks).map((entry) => entry.heading)).toEqual([null, 'Sales', 'Sales']);
    expect(hasTables(blocks)).toBe(true);
    expect(hasTables(parseMarkdown('no | table here'))).toBe(false);
  });
});

describe('document model: inline content', () => {
  it('keeps bold, italic, strikethrough, inline code and hard breaks', () => {
    const [paragraph] = parseMarkdown('**b** *i* ~~s~~ `c` ***bi***  \nnext\\\nlast');
    expect((paragraph as Extract<Block, { type: 'paragraph' }>).runs).toEqual([
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'i', italic: true },
      { text: ' ' },
      { text: 's', strike: true },
      { text: ' ' },
      { text: 'c', code: true },
      { text: ' ' },
      { text: 'bi', bold: true, italic: true },
      { text: '', break: true },
      { text: 'next' },
      { text: '', break: true },
      { text: 'last' },
    ]);
  });

  it('links only http, https and mailto addresses; others stay text', () => {
    const [paragraph] = parseMarkdown(
      [
        '[web](https://example.com/a?b=1&c=2)',
        '[mail](mailto:someone@example.com)',
        '[js](javascript:alert(1))',
        '[data](data:text/html,<b>x</b>)',
        '[relative](/api/me)',
        '[file](file:///etc/passwd)',
        'https://bare.example.org',
      ].join(' '),
    );
    const runs = (paragraph as Extract<Block, { type: 'paragraph' }>).runs;
    expect(runs.filter((run) => run.href).map((run) => [run.text, run.href])).toEqual([
      ['web', 'https://example.com/a?b=1&c=2'],
      ['mail', 'mailto:someone@example.com'],
      ['https://bare.example.org', 'https://bare.example.org/'],
    ]);
    const text = runsText(runs);
    expect(text).toContain('[js](javascript:alert(1))');
    expect(text).toContain('relative');
    expect(text).not.toContain('/api/me');
    expect(text).toContain('file');
  });

  it('renders images as their alternative text and never their address', () => {
    const [paragraph] = parseMarkdown('![A chart](https://example.com/chart.png) ![](x.png)');
    const runs = (paragraph as Extract<Block, { type: 'paragraph' }>).runs;
    expect(runsText(runs)).toBe('[Image: A chart] [Image]');
    expect(JSON.stringify(runs)).not.toContain('example.com');
  });

  it('keeps raw HTML and math as literal text', () => {
    const blocks = parseMarkdown('<script>alert("x")</script>\n\nInline <b>tag</b> and $x^2$');
    expect(blocks.map((block) => textOf(block))).toEqual([
      '<script>alert("x")</script>',
      'Inline <b>tag</b> and $x^2$',
    ]);
  });
});

describe('document model: hostile input', () => {
  it('removes characters XML cannot carry, including lone surrogates', () => {
    expect(cleanText('a\u0000b\u0007c\u000bd\ufffe\r\ne\rf\ud800g\udc00h')).toBe('abcd\ne\nfgh');
    expect(cleanText('emoji \ud83d\ude00 stays')).toBe('emoji \ud83d\ude00 stays');
    const model = documentModel('  \u0001 ', 'text\u0000');
    expect(model.title).toBe('Untitled');
    expect(textOf(model.blocks[0])).toBe('text');
  });

  it('survives very deep nesting without exhausting the stack', () => {
    expect(() => parseMarkdown(`${'>'.repeat(100_000)} x`)).not.toThrow();
    const lists = Array.from({ length: 2_000 }, (_, index) => `${'  '.repeat(index)}- x`);
    expect(() => parseMarkdown(lists.join('\n'))).not.toThrow();
  });

  it('parses pathological input in linear time', () => {
    const started = Date.now();
    parseMarkdown('*a'.repeat(100_000));
    parseMarkdown(`| a | b |\n| - | - |\n${'| 1 | 2 |\n'.repeat(40_000)}`);
    parseMarkdown('['.repeat(200_000));
    parseMarkdown('`a'.repeat(100_000));
    // micromark took over a minute on the table alone.
    expect(Date.now() - started).toBeLessThan(10_000);
    // The test's own timeout must exceed the bound it asserts: a slow CI runner
    // under coverage takes over the default five seconds while still linear.
  }, 20_000);

  it('accepts only absolute, bounded http(s) and mailto links', () => {
    expect(safeHref(' https://example.com ')).toBe('https://example.com/');
    expect(safeHref('HTTP://EXAMPLE.com/x')).toBe('http://example.com/x');
    expect(safeHref('https://')).toBeUndefined();
    expect(safeHref(`https://example.com/${'a'.repeat(3000)}`)).toBeUndefined();
    expect(safeHref('vbscript:x')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });
});

describe('markdownHasTable (web hint)', () => {
  it('spots tables, also in quotes and list items', () => {
    expect(markdownHasTable('| a | b |\n| --- | :-: |\n| 1 | 2 |')).toBe(true);
    expect(markdownHasTable('a | b\n--- | ---')).toBe(true);
    expect(markdownHasTable('> | a |\n> |---|')).toBe(true);
    expect(markdownHasTable('- | a |\n  |---|')).toBe(true);
    // A single-column table needs no pipe in its delimiter row.
    expect(markdownHasTable('| a\n---')).toBe(true);
    expect(hasTables(documentModel('T', '| a\n---').blocks)).toBe(true);
  });

  it('ignores code, rules and setext headings', () => {
    expect(markdownHasTable('```\n| a |\n|---|\n```')).toBe(false);
    expect(markdownHasTable('~~~~\n| a |\n|---|\n~~~\n| b |\n~~~~')).toBe(false);
    expect(markdownHasTable('Heading\n---')).toBe(false);
    expect(markdownHasTable('text\n\n---\n')).toBe(false);
    expect(markdownHasTable('')).toBe(false);
  });
});
