/**
 * File output (v0.9): a reply or a Markdown artifact exported as a document.
 * Shared so the API and the web client agree on formats, names and limits.
 */

export const DOCUMENT_FORMATS = ['docx', 'pdf', 'xlsx', 'pptx'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_FORMAT_INFO: Record<
  DocumentFormat,
  { label: string; description: string; extension: string; mimeType: string }
> = {
  docx: {
    label: 'Word document',
    description: 'DOCX',
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  pdf: { label: 'PDF', description: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  xlsx: {
    label: 'Spreadsheet',
    description: 'XLSX, one sheet per table',
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    label: 'Presentation',
    description: 'PPTX',
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

/** The largest reply or artifact text exported as a document (UTF-8 bytes). */
export const MAX_DOCUMENT_EXPORT_INPUT_BYTES = 512 * 1024;
/** The largest document produced. */
export const MAX_DOCUMENT_EXPORT_OUTPUT_BYTES = 20 * 1024 * 1024;

export const NO_TABLES_TO_EXPORT = 'No tables to export';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/**
 * Whether Markdown appears to contain a GFM table: a row with a pipe followed
 * by a delimiter row (`| --- | :-: |`, or `---` under a single-column
 * header), outside fenced code. It errs towards yes: the web client uses it
 * to offer spreadsheet export and the API to refuse early without parsing;
 * the server's parser has the last word.
 */
export function markdownHasTable(text: string): boolean {
  let fence: string | null = null;
  let previous = '';
  for (const raw of text.split(/\r?\n/)) {
    const marker = FENCE.exec(raw)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      previous = '';
      continue;
    }
    if (marker) {
      fence = marker;
      previous = '';
      continue;
    }
    // Tables inside block quotes and list items count too.
    const line = raw.replace(/^(\s*>)+/, '').trim();
    if (previous.includes('|') && line.includes('-') && DELIMITER_ROW.test(line)) return true;
    previous = line.replace(/^([-*+]|\d{1,9}[.)])\s+/, '');
  }
  return false;
}
