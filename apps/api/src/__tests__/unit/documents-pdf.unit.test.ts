import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { documentModel } from '../../services/documents/model.js';
import { renderPdf, TooLargeError, toWinAnsi } from '../../services/documents/pdf.js';

/** PDF output, read back with PDF.js (unpdf, already a dependency for uploads). */

async function read(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { totalPages, text: text.replace(/\s+/g, ' ') };
}

const raw = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('PDF output', () => {
  it('is a complete PDF with the title, text, lists, tables and code', async () => {
    const bytes = await renderPdf(
      documentModel(
        'Report & <more>',
        [
          '# Plan <script>alert(1)</script>',
          '',
          'Some **bold** and *italic* text with a [link](https://example.com/x).',
          '',
          '- one',
          '  - nested',
          '3. three',
          '4. four',
          '',
          '| Name | Value |',
          '| --- | ---: |',
          '| a & b | 12 |',
          '',
          '```',
          '  indented();',
          '```',
          '',
          '> quoted',
          '',
          '---',
          '',
          '![A chart](https://example.com/chart.png)',
        ].join('\n'),
      ),
      20 * 1024 * 1024,
    );
    expect(raw(bytes.slice(0, 8))).toMatch(/^%PDF-1\.\d/);
    expect(raw(bytes.slice(-8))).toContain('%%EOF');
    const { totalPages, text } = await read(bytes);
    expect(totalPages).toBe(1);
    for (const expected of [
      'Report & <more>',
      'Plan <script>alert(1)</script>',
      'bold',
      'link',
      'one',
      'nested',
      '3.',
      'four',
      'Name',
      'a & b',
      'indented();',
      'quoted',
      '[Image: A chart]',
    ])
      expect(text).toContain(expected);
    // The link is an annotation; the image is never fetched or embedded.
    expect(raw(bytes)).toContain('https://example.com/x');
    expect(raw(bytes)).not.toContain('chart.png');
    expect(raw(bytes)).not.toContain('/Subtype /Image');
  });

  it('flows long content over pages and wraps very long lines', async () => {
    const markdown = [
      'word '.repeat(5_000),
      '',
      '```',
      'x'.repeat(5_000),
      '```',
      '',
      '| a | b |',
      '| - | - |',
      ...Array.from(
        { length: 200 },
        (_, index) => `| row ${index} | ${'cell '.repeat(index % 7)} |`,
      ),
      '',
      `| huge |\n| - |\n| ${'y'.repeat(20_000)} |`,
    ].join('\n');
    const { totalPages, text } = await read(await renderPdf(documentModel('Long', markdown), 20e6));
    expect(totalPages).toBeGreaterThan(5);
    expect(text).toContain('row 199');
  });

  it('stops when the file would exceed the limit', async () => {
    await expect(
      renderPdf(documentModel('Big', 'paragraph\n\n'.repeat(5_000)), 10_000),
    ).rejects.toBeInstanceOf(TooLargeError);
  });

  it('draws only what the standard fonts can (Windows-1252)', () => {
    expect(toWinAnsi('Café naïve – “quoted” € …')).toBe('Café naïve – “quoted” € …');
    expect(toWinAnsi('ő ł Ž')).toBe('o ? Ž');
    expect(toWinAnsi('a → b ≤ c ✓')).toBe('a -> b <= c v');
    expect(toWinAnsi('Привет 你好 😀')).toBe('?????? ?? ?');
    expect(toWinAnsi('tab\there\nnext\u200b')).toBe('tab    here\nnext');
  });
});
