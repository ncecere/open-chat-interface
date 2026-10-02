import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assertWellFormedXml, unzipText, xmlTexts } from '../../../test/xml.js';
import { documentModel } from '../../services/documents/model.js';
import {
  MAX_CELL_CHARS,
  MAX_SLIDES,
  paginate,
  renderPptx,
  repairParagraphProperties,
  sections,
  splitRuns,
} from '../../services/documents/pptx.js';

/** PPTX output, read back from the slide XML. */

async function slides(markdown: string, title = 'Thread title') {
  const files = unzipText(await renderPptx(documentModel(title, markdown)));
  const names = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  return {
    files,
    slides: names.map((name) => files[name]!),
    texts: names.map((name) => xmlTexts(files[name]!, 'a:t')),
  };
}

describe('PPTX output', () => {
  it('makes a title slide and one slide per top-level heading', async () => {
    const { texts } = await slides(
      ['Opening words.', '', '# First', '', 'Alpha', '', '# Second', '', '- Beta'].join('\n'),
    );
    expect(texts.map((slide) => slide[0])).toEqual([
      'Thread title',
      'Thread title',
      'First',
      'Second',
    ]);
    expect(texts[1]).toEqual(['Thread title', 'Opening words.']);
    expect(texts[3]).toEqual(['Second', 'Beta']);
  });

  it('splits at second-level headings under a single top-level one, which titles the deck', async () => {
    const { texts } = await slides(
      [
        '# Quarterly plan',
        '',
        'Intro',
        '',
        '## Goals',
        '',
        '### Detail',
        '',
        'Text',
        '',
        '## Risks',
      ].join('\n'),
    );
    expect(texts[0]).toEqual(['Quarterly plan', 'Thread title']);
    expect(texts.slice(1).map((slide) => slide[0])).toEqual(['Quarterly plan', 'Goals', 'Risks']);
    // Deeper headings become bold lines on their section's slide.
    expect(texts[2]).toEqual(['Goals', 'Detail', 'Text']);
  });

  it('makes bullets of paragraphs and lists, numbered where ordered, keeping nesting', async () => {
    const { slides: xml } = await slides(
      ['# List', '', 'A paragraph', '', '- one', '  - nested', '', '3. three', '4. four'].join(
        '\n',
      ),
    );
    const slide = xml[1]!;
    expect(slide).toContain('<a:buChar char="&#x2022;"/>');
    expect((slide.match(/<a:buAutoNum type="arabicPeriod" startAt="3"\/>/g) ?? []).length).toBe(2);
    expect(slide).toMatch(/<a:pPr lvl="1"[^>]*>.*?<\/a:pPr><a:r>.*?<a:t>nested<\/a:t>/);
  });

  it('writes tables as slide tables, continuing long ones with the header repeated', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| r${index} | ${index} |`);
    const { texts, slides: xml } = await slides(
      ['# Data', '', 'Before', '', '| Name | Value |', '| --- | ---: |', ...rows, '', 'After'].join(
        '\n',
      ),
    );
    const tableSlides = xml.filter((slide) => slide.includes('<a:tbl>'));
    expect(tableSlides.length).toBeGreaterThan(1);
    for (const slide of tableSlides)
      expect(xmlTexts(slide, 'a:t').slice(1, 3)).toEqual(['Name', 'Value']);
    const all = texts.flat();
    expect(all).toContain('r0');
    expect(all).toContain('r39');
    expect(texts.at(-1)).toEqual(['Data (continued)', 'After']);
    expect(texts[1]).toEqual(['Data', 'Before']);
  });

  it('continues long content over several slides', async () => {
    const { texts } = await slides(
      ['# Long', '', 'word '.repeat(4_000), '', '```', 'line\n'.repeat(60), '```'].join('\n'),
    );
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.slice(2).every((slide) => slide[0] === 'Long (continued)')).toBe(true);
    expect(texts.flat().join(' ').match(/word/g)?.length).toBe(4_000);
  });

  it('escapes content, links only safe addresses and writes valid paragraphs', async () => {
    const { files, slides: xml } = await slides(
      [
        '# <script>alert("x")</script> & co',
        '',
        'Text with **bold** and a [link](https://example.com/?a=1&b=2) and [bad](javascript:x).',
      ].join('\n'),
      'Deck "one" & <two>',
    );
    for (const [path, content] of Object.entries(files)) assertWellFormedXml(content, path);
    const slide = xml[1]!;
    expect(slide).not.toContain('<script>');
    expect(xmlTexts(slide, 'a:t')[0]).toBe('<script>alert("x")</script> & co');
    // One set of paragraph properties per paragraph, always first.
    expect(slide).not.toMatch(/<\/a:r><a:pPr/);
    const rels = files['ppt/slides/_rels/slide2.xml.rels']!;
    expect(rels).toContain('Target="https://example.com/?a=1&amp;b=2"');
    expect(rels).not.toContain('javascript');
    expect(files['docProps/core.xml']).toContain('Deck &quot;one&quot; &amp; &lt;two&gt;');
  });

  it('refuses content that would need more than the maximum number of slides', async () => {
    const many = Array.from({ length: MAX_SLIDES }, (_, index) => `# Part ${index}`).join('\n\n');
    await expect(renderPptx(documentModel('T', many))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(`needs ${MAX_SLIDES + 1} slides`),
    });
    const fits = Array.from({ length: MAX_SLIDES - 1 }, (_, index) => `# Part ${index}`);
    await expect(renderPptx(documentModel('T', fits.join('\n\n')))).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it('gives an empty document its title slide and nothing else', async () => {
    const { texts } = await slides('', 'Empty');
    expect(texts).toEqual([['Empty']]);
  });
});

describe('PPTX layout helpers', () => {
  it('takes the deck title from the content only when there is a single top heading', () => {
    expect(sections(documentModel('T', '# A\n\n# B')).deckTitle).toBe('T');
    expect(sections(documentModel('T', '## A\n\n### B')).deckTitle).toBe('A');
    expect(sections(documentModel('T', 'text')).sections).toEqual([
      { title: 'T', blocks: [expect.objectContaining({ type: 'paragraph' })] },
    ]);
    expect(sections(documentModel('T', '')).sections).toEqual([]);
  });

  it('paginates an empty section as one slide', () => {
    expect(paginate({ title: 'Only', blocks: [] })).toEqual([{ title: 'Only', items: [] }]);
  });

  it('shortens oversized table cells', () => {
    const [slide] = paginate({
      title: 'T',
      blocks: [
        {
          type: 'table',
          align: [null],
          header: [[{ text: 'h' }]],
          rows: [[[{ text: 'z'.repeat(MAX_CELL_CHARS * 2) }]]],
        },
      ],
    });
    expect(slide!.table!.rows[0]![0]).toHaveLength(MAX_CELL_CHARS);
    expect(slide!.table!.rows[0]![0]!.endsWith('\u2026')).toBe(true);
  });

  it('splits runs at spaces, keeping their styles', () => {
    expect(splitRuns([{ text: 'aaa bbb', bold: true }, { text: 'ccc' }], 5)).toEqual([
      [{ text: 'aaa ', bold: true }],
      [{ text: 'bbb', bold: true }, { text: 'cc' }],
      [{ text: 'c' }],
    ]);
    expect(splitRuns([{ text: 'x'.repeat(7) }], 3)).toEqual([
      [{ text: 'xxx' }],
      [{ text: 'xxx' }],
      [{ text: 'x' }],
    ]);
  });

  it('removes paragraph properties that do not start their paragraph', () => {
    const slide =
      '<a:p><a:pPr lvl="1"><a:buNone/></a:pPr><a:r><a:t>a</a:t></a:r><a:pPr indent="0"/><a:r><a:t>b</a:t></a:r><a:br/><a:pPr><a:buNone/></a:pPr><a:r><a:t>c</a:t></a:r></a:p>';
    const repaired = unzipText(
      repairParagraphProperties(
        zipSync({ 'ppt/slides/slide1.xml': strToU8(slide), 'other.xml': strToU8('<a:pPr/>') }),
      ),
    );
    expect(repaired['ppt/slides/slide1.xml']).toBe(
      '<a:p><a:pPr lvl="1"><a:buNone/></a:pPr><a:r><a:t>a</a:t></a:r><a:r><a:t>b</a:t></a:r><a:br/><a:r><a:t>c</a:t></a:r></a:p>',
    );
    expect(repaired['other.xml']).toBe('<a:pPr/>');
  });
});
