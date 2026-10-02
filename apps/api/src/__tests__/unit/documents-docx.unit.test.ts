import { describe, expect, it } from 'vitest';
import { assertWellFormedXml, unzipText, xmlTexts } from '../../../test/xml.js';
import { renderDocx } from '../../services/documents/docx.js';
import { documentModel } from '../../services/documents/model.js';

/** DOCX output, read back from the package's XML. */

const SAMPLE = [
  '# Plan <script>alert("x")</script>',
  '',
  'Some **bold**, *italic*, ~~gone~~, `code` & a [link](https://example.com/a?b=1&c=2).',
  'A [bad link](javascript:alert(1)).',
  '',
  '- one',
  '  - nested',
  '    1. deep',
  '- two',
  '',
  '3. three',
  '4. four',
  '',
  '| Name | Value |',
  '| :--- | ---: |',
  '| a & b | 12 |',
  '',
  '```js',
  '  indented();',
  'second <line>',
  '```',
  '',
  '> quoted',
  '',
  '---',
  '',
  '![A chart](https://example.com/chart.png)',
].join('\n');

async function render(markdown: string, title = 'Report "Q1" & <more>') {
  const files = unzipText(await renderDocx(documentModel(title, markdown)));
  return { files, document: files['word/document.xml']! };
}

describe('DOCX output', () => {
  it('produces well-formed parts with every character escaped', async () => {
    const { files, document } = await render(SAMPLE);
    for (const [path, xml] of Object.entries(files)) assertWellFormedXml(xml, path);
    expect(document).not.toContain('<script>');
    expect(document).toContain('&lt;script&gt;');
    expect(files['docProps/core.xml']).toContain('Report &quot;Q1&quot; &amp; &lt;more&gt;');
  });

  it('titles the document and keeps headings, inline styles and code', async () => {
    const { document } = await render(SAMPLE);
    const texts = xmlTexts(document, 'w:t');
    expect(texts[0]).toBe('Report "Q1" & <more>');
    expect(document).toMatch(/<w:pStyle w:val="Title"\/>/);
    expect(document).toMatch(
      /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Plan &lt;script&gt;/,
    );
    expect(document).toMatch(/<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">bold</);
    expect(document).toMatch(/<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">italic</);
    expect(document).toMatch(/<w:strike\/><\/w:rPr><w:t xml:space="preserve">gone</);
    expect(document).toMatch(
      /Courier New[^<]*\/>(<w:[^>]*>)*<\/w:rPr><w:t xml:space="preserve">code</,
    );
    // Code blocks keep their indentation, one line per break, in monospace.
    expect(texts).toContain('  indented();');
    expect(texts).toContain('second <line>');
    expect(texts).toContain('[Image: A chart]');
    expect(document).not.toContain('chart.png');
  });

  it('links only safe addresses', async () => {
    const { files, document } = await render(SAMPLE);
    const rels = files['word/_rels/document.xml.rels']!;
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2"');
    expect(rels).not.toContain('javascript');
    expect(document).toMatch(/<w:hyperlink[^>]*>.*?link<\/w:t>/);
    expect(xmlTexts(document, 'w:t').join('')).toContain('A [bad link](javascript:alert(1)).');
  });

  it('writes Word lists: nested bullets and numbering that keeps its start', async () => {
    const { files, document } = await render(SAMPLE);
    const levels = [...document.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)].map(
      (match) => Number(match[1]),
    );
    // one, nested, deep, two, three, four
    expect(levels).toEqual([0, 1, 2, 0, 0, 0]);
    const numbering = files['word/numbering.xml']!;
    expect(numbering).toContain('<w:start w:val="3"/>');
    expect(numbering).toContain('w:val="bullet"');
    expect(numbering).toContain('w:val="decimal"');
  });

  it('writes tables with a repeated, bold header row and column alignment', async () => {
    const { document } = await render(SAMPLE);
    const table = /<w:tbl>.*<\/w:tbl>/.exec(document)?.[0] ?? '';
    expect(table).toContain('<w:tblHeader/>');
    expect(xmlTexts(table, 'w:t')).toEqual(['Name', 'Value', 'a & b', '12']);
    expect(table).toMatch(/<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Name/);
    expect(table).toContain('<w:jc w:val="right"/>');
    expect((table.match(/<w:gridCol /g) ?? []).length).toBe(2);
  });

  it('handles empty content, very long lines and deep nesting', async () => {
    const long = 'x'.repeat(200_000);
    const nested = Array.from(
      { length: 30 },
      (_, index) => `${'  '.repeat(index)}- level ${index}`,
    );
    const { document } = await render(
      [long, '', ...nested, '', '>'.repeat(50) + ' deep'].join('\n'),
    );
    expect(document).toContain(long);
    expect(document).toContain('level 29');
    expect(document).toContain('deep');
    const empty = await render('', 'Empty');
    expect(xmlTexts(empty.document, 'w:t')).toEqual(['Empty']);
  });
});
