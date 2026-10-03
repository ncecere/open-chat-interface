import { NO_TABLES_TO_EXPORT } from '@oci/shared';
import { strToU8, zipSync } from 'fflate';
import { collectTables, type DocumentModel, runsText, type TableBlock } from './model.js';

/**
 * XLSX output: one worksheet per GFM table, header row bold and frozen,
 * numbers stored as numbers. Written directly as SpreadsheetML and zipped
 * with fflate (already a dependency) rather than with exceljs, whose
 * dependency tree (archiver, unzipper, tmp and a dozen deprecated packages) is
 * far larger than the few parts a table needs. Tests read the files back with
 * exceljs.
 *
 * All text is stored as shared strings, never formulas, so a cell such as
 * "=HYPERLINK(…)" stays text.
 */

/** Excel's own limit on a cell's text. */
const MAX_CELL_CHARS = 32_767;
const MAX_SHEET_NAME = 31;

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A1-style column letters for a zero-based index. */
export function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

type CellValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; percent: boolean };

/**
 * A cell's value: plain numbers ("12", "-3.5", "1,234,567.89") and
 * percentages ("12.5%") become numbers; anything else, including numbers
 * with leading zeros ("007") or more than 15 digits, stays text.
 */
export function cellValue(text: string): CellValue {
  const trimmed = text.trim();
  const match = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)$/.exec(trimmed);
  if (match) {
    const [, sign, whole, fraction = '', percent] = match;
    const digits = whole!.replace(/,/g, '');
    const significant = (digits + fraction.slice(1)).replace(/^0+/, '');
    const leadingZero = digits.length > 1 && digits.startsWith('0');
    if (!leadingZero && significant.length <= 15) {
      const value = Number(`${sign}${digits}${fraction}`);
      if (Number.isFinite(value))
        return percent
          ? { kind: 'number', value: value / 100, percent: true }
          : { kind: 'number', value, percent: false };
    }
  }
  return { kind: 'text', text: text.slice(0, MAX_CELL_CHARS) };
}

/** Unique, valid worksheet names: at most 31 characters, none of : \ / ? * [ ]. */
export function sheetNames(candidates: Array<string | null>): string[] {
  const used = new Set<string>();
  return candidates.map((candidate, index) => {
    const cleaned = (candidate ?? '')
      .replace(/[:\\/?*[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '');
    const base = cleaned && cleaned.toLowerCase() !== 'history' ? cleaned : `Table ${index + 1}`;
    let name = base.slice(0, MAX_SHEET_NAME).trim();
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
      const tail = ` (${suffix})`;
      name = base.slice(0, MAX_SHEET_NAME - tail.length).trim() + tail;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

class SharedStrings {
  readonly values: string[] = [];
  private readonly index = new Map<string, number>();
  count = 0;

  add(value: string): number {
    this.count++;
    let position = this.index.get(value);
    if (position === undefined) {
      position = this.values.length;
      this.values.push(value);
      this.index.set(value, position);
    }
    return position;
  }
}

/** Style ids in styles.xml: 0 normal, 1 bold header, 2 percentage. */
const STYLE = { normal: 0, header: 1, percent: 2 } as const;

function worksheet(table: TableBlock, strings: SharedStrings): string {
  const rows = [table.header, ...table.rows];
  const widths = table.header.map((_, column) =>
    Math.min(60, Math.max(8, ...rows.map((row) => runsText(row[column] ?? []).length + 2))),
  );
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((runs, column) => {
          const reference = `${columnName(column)}${rowIndex + 1}`;
          const text = runsText(runs);
          if (rowIndex === 0) {
            const id = strings.add(text.slice(0, MAX_CELL_CHARS));
            return `<c r="${reference}" t="s" s="${STYLE.header}"><v>${id}</v></c>`;
          }
          if (!text.trim()) return '';
          const value = cellValue(text);
          if (value.kind === 'number')
            return `<c r="${reference}"${value.percent ? ` s="${STYLE.percent}"` : ''}><v>${value.value}</v></c>`;
          return `<c r="${reference}" t="s"><v>${strings.add(value.text)}</v></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const columns = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    `<cols>${columns}</cols><sheetData>${body}</sheetData></worksheet>`
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

export function renderXlsx(model: DocumentModel): Uint8Array {
  const tables = collectTables(model.blocks);
  if (tables.length === 0) throw new Error(NO_TABLES_TO_EXPORT);
  const names = sheetNames(tables.map((entry) => entry.heading));
  const strings = new SharedStrings();
  const sheets = tables.map((entry) => worksheet(entry.table, strings));

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        sheets
          .map(
            (_, index) =>
              `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    ),
    'docProps/core.xml': strToU8(
      `${header}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${xml(model.title)}</dc:title><dc:creator>${xml(model.creator)}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>` +
        '</cp:coreProperties>',
    ),
    'xl/workbook.xml': strToU8(
      `${header}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names
          .map(
            (name, index) =>
              `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES),
    'xl/sharedStrings.xml': strToU8(
      `${header}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.count}" uniqueCount="${strings.values.length}">` +
        strings.values
          .map((value) => `<si><t xml:space="preserve">${xml(value)}</t></si>`)
          .join('') +
        '</sst>',
    ),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheet);
  });
  return zipSync(files, { level: 6 });
}
