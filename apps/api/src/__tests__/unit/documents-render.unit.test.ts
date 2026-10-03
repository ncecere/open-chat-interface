import {
  DOCUMENT_FORMATS,
  MAX_DOCUMENT_EXPORT_INPUT_BYTES,
  NO_TABLES_TO_EXPORT,
} from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { MAX_CONCURRENT_GENERATIONS, withGenerationSlot } from '../../services/documents/export.js';
import {
  assertExportable,
  DOCUMENT_TOO_LARGE,
  documentDisposition,
  prepareDocument,
  renderDocument,
  renderInWorker,
} from '../../services/documents/render.js';

/** The format-independent checks around generation. */

const TABLE = '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |';
const signatures: Record<string, string> = { docx: 'PK', xlsx: 'PK', pptx: 'PK', pdf: '%PDF' };

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected a failure');
}

describe('document rendering', () => {
  it.each(DOCUMENT_FORMATS)('renders %s', async (format) => {
    const bytes = await renderDocument(format, await prepareDocument(format, 'Title', TABLE));
    expect(Buffer.from(bytes.slice(0, 4)).toString('latin1')).toContain(signatures[format]);
  });

  it('refuses empty and oversized text', async () => {
    const empty = await failure(prepareDocument('docx', 'T', '  \n '));
    expect(empty).toMatchObject({ status: 422, message: 'There is no text to export.' });
    // Measured in UTF-8 bytes, not characters.
    const tooBig = await failure(
      prepareDocument('docx', 'T', '\u00e9'.repeat(MAX_DOCUMENT_EXPORT_INPUT_BYTES / 2 + 1)),
    );
    expect(tooBig.status).toBe(422);
    expect(tooBig.message).toContain('512 KB');
    await expect(
      prepareDocument('docx', 'T', 'a'.repeat(MAX_DOCUMENT_EXPORT_INPUT_BYTES)),
    ).resolves.toBeTruthy();
  });

  it('refuses a spreadsheet of content without tables', async () => {
    const error = await failure(prepareDocument('xlsx', 'T', '# Just text'));
    expect(error).toMatchObject({ status: 422, message: NO_TABLES_TO_EXPORT });
  });

  it('makes the early checks without parsing', () => {
    expect(() => assertExportable('docx', ' ')).toThrow('There is no text to export.');
    expect(() => assertExportable('xlsx', '# Just text')).toThrow(NO_TABLES_TO_EXPORT);
    expect(() => assertExportable('xlsx', TABLE)).not.toThrow();
    expect(() => assertExportable('docx', '# Just text')).not.toThrow();
    // Looks like a table to the line scan, but the columns do not match: the
    // parser in the worker refuses it.
    expect(() => assertExportable('xlsx', 'a | b\n---')).not.toThrow();
  });

  it.each(DOCUMENT_FORMATS)('refuses a %s larger than the output limit', async (format) => {
    const model = await prepareDocument(format, 'T', `${TABLE}\n\n${'text\n\n'.repeat(2_000)}`);
    const error = await failure(renderDocument(format, model, 1_000));
    expect(error).toMatchObject({ status: 422, message: DOCUMENT_TOO_LARGE });
  });

  it('names the download with the format’s extension', () => {
    expect(documentDisposition('plan-reply-2026-10-02', 'pptx')).toBe(
      'attachment; filename="plan-reply-2026-10-02.pptx"',
    );
  });
});

describe('generation slots', () => {
  it('allows one generation per person and a few per replica', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Array.from({ length: MAX_CONCURRENT_GENERATIONS }, (_, index) =>
      withGenerationSlot(`user-${index}`, () => blocker.then(() => index)),
    );
    const same = await failure(withGenerationSlot('user-0', async () => 0));
    expect(same).toMatchObject({ status: 429, retryAfterSeconds: 5 });
    expect(same.message).toContain('already being prepared');
    const busy = await failure(withGenerationSlot('someone-else', async () => 0));
    expect(busy.message).toContain('prepared for others');
    release();
    expect(await Promise.all(running)).toEqual([0, 1]);
    await expect(withGenerationSlot('user-0', async () => 'again')).resolves.toBe('again');
  });

  it('releases the slot when generation fails', async () => {
    await expect(
      withGenerationSlot('failing', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withGenerationSlot('failing', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('generation in a worker thread', () => {
  it('returns the file', async () => {
    const bytes = await renderInWorker('docx', 'Title', TABLE);
    expect(Buffer.from(bytes.slice(0, 2)).toString('latin1')).toBe('PK');
  });

  it('passes on refusals as they are', async () => {
    const error = await failure(renderInWorker('xlsx', 'T', 'no tables'));
    expect(error).toMatchObject({ status: 422, message: NO_TABLES_TO_EXPORT });
    const mismatched = await failure(renderInWorker('xlsx', 'T', 'a | b\n---'));
    expect(mismatched).toMatchObject({ status: 422, message: NO_TABLES_TO_EXPORT });
  });

  it('reports content that exhausts its memory or time as too complex', async () => {
    const dense = `${TABLE}\n\n${'- **item** [link](https://example.com)\n'.repeat(12_000)}`;
    const memory = await failure(
      renderInWorker('docx', 'T', dense, { timeoutMs: 60_000, heapMb: 16 }),
    );
    expect(memory.status).toBe(422);
    expect(memory.message).toContain('too long or complex to export as DOCX');
    const time = await failure(renderInWorker('pdf', 'T', dense, { timeoutMs: 1, heapMb: 512 }));
    expect(time.message).toContain('too long or complex to export as PDF');
  });
});
