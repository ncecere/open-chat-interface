import { NO_TABLES_TO_EXPORT } from '@oci/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { assertWellFormedXml, unzipText } from '../../../test/xml.js';
import { documentModel } from '../../services/documents/model.js';
import { cellValue, columnName, renderXlsx, sheetNames } from '../../services/documents/xlsx.js';

/** XLSX output, written by OCI and read back with exceljs (a test-only dependency). */

async function workbook(markdown: string) {
  const bytes = renderXlsx(documentModel('Sales <&> "Q1"', markdown));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return { book, bytes };
}

const values = (sheet: ExcelJS.Worksheet) => {
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
};

const SAMPLE = [
  'Intro text is not exported.',
  '',
  '## Revenue: Q1/Q2 [draft]',
  '',
  '| Region | Revenue | Share | Code | Formula |',
  '| --- | ---: | --: | --- | --- |',
  '| North <b> | 1,234.5 | 12.5% | 007 | =HYPERLINK("http://x") |',
  '| South & "co" | -42 | 3% | 1234567890123456789 | **bold** [link](https://x.example) |',
  '| Empty |  |  |  |  |',
  '',
  '- In a list:',
  '',
  '  | a | b |',
  '  |---|---|',
  '  | 1 | 2 |',
].join('\n');

describe('XLSX output', () => {
  it('writes one sheet per table, named after the heading above it', async () => {
    const { book } = await workbook(SAMPLE);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
      'Revenue Q1 Q2 draft',
      'Revenue Q1 Q2 draft (2)',
    ]);
    expect(values(book.worksheets[1]!)).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
  });

  it('keeps text as text, detects numbers and percentages, and bolds the header', async () => {
    const { book } = await workbook(SAMPLE);
    const sheet = book.worksheets[0]!;
    expect(values(sheet)).toEqual([
      ['Region', 'Revenue', 'Share', 'Code', 'Formula'],
      ['North <b>', 1234.5, 0.125, '007', '=HYPERLINK("http://x")'],
      ['South & "co"', -42, 0.03, '1234567890123456789', 'bold link'],
      ['Empty'],
    ]);
    expect(sheet.getCell('A1').font?.bold).toBe(true);
    expect(sheet.getCell('E1').font?.bold).toBe(true);
    expect(sheet.getCell('A2').font?.bold).toBeFalsy();
    expect(sheet.getCell('C2').numFmt).toBe('0.00%');
    // Text that looks like a formula is never a formula.
    expect(sheet.getCell('E2').formula).toBeUndefined();
    expect(sheet.getCell('E2').type).toBe(ExcelJS.ValueType.String);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('writes well-formed, escaped parts with the title in the properties', async () => {
    const { bytes } = await workbook(SAMPLE);
    const files = unzipText(bytes);
    for (const [path, xml] of Object.entries(files)) assertWellFormedXml(xml, path);
    expect(files['docProps/core.xml']).toContain('Sales &lt;&amp;&gt; &quot;Q1&quot;');
    expect(files['xl/sharedStrings.xml']).toContain('North &lt;b&gt;');
    expect(files['xl/sharedStrings.xml']).not.toContain('<b>');
  });

  it('refuses content without tables', () => {
    expect(() => renderXlsx(documentModel('T', 'No tables | here'))).toThrow(NO_TABLES_TO_EXPORT);
  });

  it('detects numbers conservatively', () => {
    expect(cellValue('42')).toEqual({ kind: 'number', value: 42, percent: false });
    expect(cellValue(' -1,000,000.25 ')).toEqual({
      kind: 'number',
      value: -1000000.25,
      percent: false,
    });
    expect(cellValue('+7')).toEqual({ kind: 'number', value: 7, percent: false });
    expect(cellValue('0')).toEqual({ kind: 'number', value: 0, percent: false });
    expect(cellValue('0.5')).toEqual({ kind: 'number', value: 0.5, percent: false });
    expect(cellValue('50%')).toEqual({ kind: 'number', value: 0.5, percent: true });
    for (const text of [
      '007',
      '1,23',
      '12abc',
      '1.2.3',
      '$5',
      '1e5',
      '',
      '1234567890123456',
      'NaN',
    ])
      expect(cellValue(text).kind).toBe('text');
    expect(cellValue('x'.repeat(40_000))).toEqual({ kind: 'text', text: 'x'.repeat(32_767) });
  });

  it('makes valid, unique sheet names', () => {
    expect(
      sheetNames([
        null,
        'History',
        'a:b/c?d*e[f]g\\h',
        "'quoted'",
        'x'.repeat(40),
        'x'.repeat(40),
        'Same',
        'same',
      ]),
    ).toEqual([
      'Table 1',
      'Table 2',
      'a b c d e f g h',
      'quoted',
      'x'.repeat(31),
      `${'x'.repeat(27)} (2)`,
      'Same',
      'same (2)',
    ]);
  });

  it('names columns past Z', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });
});
