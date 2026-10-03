import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { documentModel } from '../../services/documents/model.js';
import { renderPdf } from '../../services/documents/pdf.js';
import { PDF_FONT_FACES, sliceFile } from '../../services/documents/pdf-font-faces.js';
import {
  cjkOrder,
  FontBook,
  loadFontCatalog,
  needsUnicodeFonts,
  PLACEHOLDER,
  TextEngine,
} from '../../services/documents/pdf-text.js';
import { inspectPdf } from './pdf-inspect.js';

/**
 * PDF export in every script (v0.10): embedded Noto fonts chosen per run of
 * characters, right-to-left paragraphs ordered by the bidirectional
 * algorithm, Arabic shaped. Read back two ways: PDF.js (unpdf) for the text,
 * and the content streams themselves for the glyphs drawn (no `.notdef`).
 */

async function render(title: string, markdown: string) {
  const bytes = await renderPdf(documentModel(title, markdown), 20 * 1024 * 1024);
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return {
    bytes,
    totalPages,
    // PDF.js's text, without the control characters it gives glyphs that
    // stand for no character of their own (Arabic dots drawn separately).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing exactly those.
    text: text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ''),
    lines: text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: as above.
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .split('\n')
      .map((line) => line.trim()),
    inspection: inspectPdf(bytes),
  };
}

/** Every embedded glyph has a character: nothing was drawn as `.notdef` (code 0). */
function expectNoNotdef(inspection: ReturnType<typeof inspectPdf>) {
  const notdef = inspection.drawn.filter((drawn) => drawn.codes.includes(0));
  expect(notdef).toEqual([]);
  expect(inspection.drawn.length).toBeGreaterThan(0);
}

const SAMPLES = {
  English: 'The quick brown fox jumps over the lazy dog.',
  Greek: 'Καλημέρα κόσμε, ελληνικά.',
  Cyrillic: 'Привет, мир. Съешь же ещё этих булок.',
  Chinese: '你好，世界。这是一个测试。',
  Japanese: 'こんにちは、世界。カタカナと漢字。',
  Korean: '안녕하세요, 세계.',
  Arabic: 'مرحبا بالعالم',
  Hebrew: 'שלום עולם',
};

describe('PDF export in every script', () => {
  it('draws English, Greek, Cyrillic, Arabic, Hebrew and CJK with embedded fonts and no .notdef', async () => {
    const markdown = Object.entries(SAMPLES)
      .map(([name, sample]) => `## ${name}\n\n${sample}`)
      .join('\n\n');
    const { text, inspection } = await render('Scripts', markdown);
    expectNoNotdef(inspection);
    for (const sample of [SAMPLES.English, SAMPLES.Greek, SAMPLES.Cyrillic, SAMPLES.Korean])
      expect(text).toContain(sample);
    expect(text).toContain('你好，世界。这是一个测试。');
    expect(text).toContain('こんにちは、世界。カタカナと漢字。');
    // Right-to-left, read left to right: the last word first.
    expect(text).toContain('עולם שלום');
    expect(text).toContain('بالعالم مرحبا');
    // One font per script, each embedded (subset), the standard fonts unused.
    expect(inspection.embedded).toEqual(
      expect.arrayContaining([
        'NotoSans-Regular',
        'NotoSans-Bold',
        'NotoSansArabic-Regular',
        'NotoSansHebrew-Regular',
        'NotoSansJP-Regular',
        'NotoSansKR-Regular',
      ]),
    );
    expect(inspection.standard).toEqual([]);
    // Text is drawn in visual order: a right-to-left word reads reversed.
    const fontOf = (sample: string) =>
      new Set(
        inspection.drawn
          .filter(
            ({ text: drawn }) =>
              drawn.trim().length > 1 &&
              (sample.includes(drawn) || sample.includes([...drawn].reverse().join(''))),
          )
          .map((drawn) => drawn.font),
      );
    expect(fontOf(SAMPLES.Greek)).toEqual(new Set(['NotoSans-Regular']));
    expect(fontOf(SAMPLES.Hebrew)).toEqual(new Set(['NotoSansHebrew-Regular']));
    expect(fontOf(SAMPLES.Korean)).toEqual(new Set(['NotoSansKR-Regular']));
  });

  it('chooses the CJK family per document: Chinese, Japanese (kana) or Korean (Hangul)', async () => {
    const chinese = await render('中文', `${SAMPLES.Chinese}\n\n繁體中文：臺灣。`);
    expectNoNotdef(chinese.inspection);
    expect(chinese.text).toContain('繁體中文：臺灣。');
    expect(chinese.inspection.embedded).toContain('NotoSansSC-Regular');
    expect(chinese.inspection.embedded).not.toContain('NotoSansJP-Regular');

    const japanese = await render('日本語', `${SAMPLES.Japanese}\n\n日本語の漢字。`);
    expectNoNotdef(japanese.inspection);
    expect(japanese.inspection.embedded).toContain('NotoSansJP-Regular');
    expect(japanese.inspection.embedded).not.toContain('NotoSansSC-Regular');

    const korean = await render('한국어', `${SAMPLES.Korean} 漢字`);
    expectNoNotdef(korean.inspection);
    expect(korean.inspection.embedded).toContain('NotoSansKR-Regular');
    expect(korean.text).toContain('안녕하세요, 세계. 漢字');
    expect(cjkOrder('かな')[0]).toBe('jp');
    expect(cjkOrder('한')[0]).toBe('kr');
    expect(cjkOrder('漢')[0]).toBe('sc');
  });

  it('shapes Arabic: a letter takes its initial, medial and final forms', async () => {
    const { inspection } = await render('Shaping', 'ببب and ب');
    expectNoNotdef(inspection);
    // A right-to-left paragraph: drawn from the left, the lone letter comes
    // first, then "and", then the word. (pdfkit draws each glyph positioned
    // by the font, such as the dot below, as a string of its own.)
    const and = inspection.drawn.findIndex((drawn) => drawn.text === 'and');
    const arabic = (drawn: typeof inspection.drawn) =>
      drawn.filter((item) => item.font === 'NotoSansArabic-Regular').flatMap((item) => item.codes);
    const alone = arabic(inspection.drawn.slice(0, and));
    const word = arabic(inspection.drawn.slice(and + 1));
    // Unshaped, the word would be the isolated letter three times. Shaped, it
    // has three glyphs that are not part of the isolated letter (the dot,
    // drawn as a mark of its own, is shared).
    const forms = word.filter((code) => !alone.includes(code));
    expect(new Set(forms).size).toBe(3);
  });

  it('orders right-to-left paragraphs, mixed with numbers and Latin, and wraps them from the right', async () => {
    const words = Array.from({ length: 80 }, () => 'שלום').join(' ');
    const { lines, text, inspection } = await render(
      'RTL',
      [
        'עברית: שלום עולם 123 (סוגריים)',
        '',
        'English with עברית inside, then more English.',
        '',
        `התחלה ${words} סוף`,
        '',
        'العربية: مرحبا بالعالم 2026',
      ].join('\n'),
    );
    expectNoNotdef(inspection);
    // Numbers stay left to right; brackets are mirrored with the text around them.
    expect(text).toContain('(סוגריים) 123 עולם שלום :עברית');
    expect(text).toContain('English with עברית inside, then more English.');
    expect(text).toContain('2026 بالعالم مرحبا :العربية');
    // The long paragraph starts on the right of its first line and ends on its last.
    const first = lines.findIndex((line) => line.endsWith('התחלה'));
    const last = lines.findIndex((line) => line.startsWith('סוף'));
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first + 1);
  });

  it('draws emoji as a placeholder, and keeps tables, code, links and every block in any script', async () => {
    const { text, inspection, bytes } = await render(
      'Mixed 混合',
      [
        '# Заголовок 标题',
        '',
        'Emoji: 😀 👍🏽 ✨ and a [ссылка](https://example.com/ru) **жирный** *курсив* ~~удалено~~ `код`',
        '',
        '- первый пункт',
        '1. 第一',
        '',
        '> цитата שלום',
        '',
        '---',
        '',
        '| Имя | 名前 | שם |',
        '| :--- | :---: | ---: |',
        '| Анна | 花子 | דנה |',
        '| very long cell text that wraps in the column several times over | 長い | ארוך |',
        '',
        '```',
        'const привет = "世界"; // שלום',
        '\tindented',
        '```',
      ].join('\n'),
    );
    expectNoNotdef(inspection);
    for (const expected of [
      'Заголовок 标题',
      'ссылка',
      'жирный',
      'первый пункт',
      '第一',
      'цитата',
      'Имя',
      '名前',
      'Анна',
      '花子',
      'const привет = "世界"; //',
      'indented',
    ])
      expect(text).toContain(expected);
    // One placeholder per emoji; the skin tone modifier is dropped.
    expect(text).toContain(`Emoji: ${PLACEHOLDER} ${PLACEHOLDER} ${PLACEHOLDER}`);
    // The link is still an annotation; code that fits Windows-1252 stays Courier.
    expect(Buffer.from(bytes).toString('latin1')).toContain('https://example.com/ru');
    expect(inspection.standard).toContain('Courier');
    expect(inspection.embedded).toContain('NotoSans-Italic');
  });

  it('flows long CJK text over pages quickly', async () => {
    const paragraph = '这是一个关于中文排版的测试段落，其中包含常用汉字和标点符号。'.repeat(40);
    const markdown = Array.from({ length: 40 }, (_, i) => `## 第${i}章\n\n${paragraph}`).join(
      '\n\n',
    );
    const started = performance.now();
    const { totalPages, inspection } = await render('长文档', markdown);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(totalPages).toBeGreaterThan(10);
    expectNoNotdef(inspection);
  }, 30_000);

  it('keeps Windows-1252 documents on the standard fonts, embedding nothing', async () => {
    const { inspection, bytes } = await render('Plain', 'Café naïve – “quoted” € … a → b');
    expect(inspection.embedded).toEqual([]);
    expect(inspection.standard).toEqual(expect.arrayContaining(['Helvetica']));
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('/FontFile');
    expect(needsUnicodeFonts('Café → ✓\t')).toBe(false);
    expect(needsUnicodeFonts('ő')).toBe(true);
    expect(needsUnicodeFonts('😀')).toBe(true);
  });
});

describe('the font book', () => {
  it('lists every face it may use, and skips a slice whose file is missing', () => {
    const catalog = loadFontCatalog();
    const families = new Set(catalog.map((face) => face.family));
    for (const face of PDF_FONT_FACES) expect(families.has(face.family)).toBe(true);
    // Every slice listed is installed: the image keeps exactly these files.
    const slices = catalog.flatMap((face) => face.slices);
    expect(slices.length).toBeGreaterThan(300);
    expect(slices.filter((slice) => !existsSync(slice.file))).toEqual([]);
    expect(sliceFile('noto-sans-sc', '[118]', 400, false)).toBe('noto-sans-sc-118-400-normal.woff');
    expect(sliceFile('noto-sans', 'latin', 700, true)).toBe('noto-sans-latin-700-italic.woff');

    const doc = new PDFDocument();
    const latin = catalog.find(
      (face) => face.family === 'sans' && face.weight === 400 && !face.italic,
    )!;
    const book = new FontBook(
      doc,
      ['sc', 'jp', 'kr'],
      [
        {
          family: 'sans',
          weight: 400,
          italic: false,
          slices: [{ name: 'missing', file: '/nonexistent/font.woff', ranges: [0x41, 0x5a] }],
        },
        { ...latin, family: 'hebrew' },
      ],
    );
    expect(book.available).toBe(true);
    // The missing file is skipped for the next family that has the letter.
    expect(book.pick(0x41, false, false)?.name).toMatch(/^noto-sans:latin:400/);
    expect(book.pick(0x41, false, false)?.name).toMatch(/^noto-sans:latin:400/);
    // Bold from a face with one weight is drawn with an outline.
    expect(book.pick(0x42, true, false)?.fauxBold).toBe(true);
    // Monospaced Windows-1252 text uses Courier in its four styles.
    expect(book.pick(0x41, true, true, true)?.name).toBe('Courier-BoldOblique');
    expect(book.pick(0x4e00, false, false)).toBeNull();
    expect(new FontBook(doc, ['sc'], []).available).toBe(false);
  });

  it('lays out an empty line and text no font has', () => {
    const doc = new PDFDocument();
    const engine = new TextEngine(doc, new FontBook(doc, ['sc', 'jp', 'kr']));
    const [empty] = engine.layout([{ text: '', size: 10, color: '#000' }], 100);
    expect(empty?.groups).toEqual([]);
    expect(empty!.height).toBeGreaterThan(10);
    // A private-use character: the replacement character instead.
    const [line] = engine.layout([{ text: '\ue000\u0301x', size: 10, color: '#000' }], 100);
    expect(line?.groups.map((group) => group.text).join('')).toBe(`${PLACEHOLDER}\u0301x`);
    // A word longer than the line is split between characters.
    const split = engine.layout([{ text: 'Ж'.repeat(200), size: 10, color: '#000' }], 100);
    expect(split.length).toBeGreaterThan(3);
    expect(split.every((part) => part.width <= 100.5)).toBe(true);
  });
});
