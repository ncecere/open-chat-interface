import { Worker } from 'node:worker_threads';
import {
  contentDisposition,
  DOCUMENT_FORMAT_INFO,
  type DocumentFormat,
  MAX_DOCUMENT_EXPORT_INPUT_BYTES,
  MAX_DOCUMENT_EXPORT_OUTPUT_BYTES,
  markdownHasTable,
  NO_TABLES_TO_EXPORT,
} from '@oci/shared';
import { AppError, validationFailed } from '../../lib/errors.js';

/**
 * Turns Markdown into a document file.
 *
 * Requests generate in a worker thread (`renderInWorker`) with its own heap
 * limit and a time limit: the generators are synchronous CPU work and, for
 * DOCX and PPTX, need far more memory than their input (hundreds of MB for a
 * dense 512 KB document), so neither the API's event loop nor its heap pays
 * for it. The parser and each generator are imported on first use, so the
 * API process itself never loads docx, pdfkit or pptxgenjs.
 */

export const DOCUMENT_TOO_LARGE = `The document would be larger than ${
  MAX_DOCUMENT_EXPORT_OUTPUT_BYTES / 1024 ** 2
} MB.`;

function assertExportableText(markdown: string): void {
  if (!markdown.trim()) throw validationFailed('There is no text to export.');
  if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT_EXPORT_INPUT_BYTES)
    throw validationFailed(
      `Text larger than ${MAX_DOCUMENT_EXPORT_INPUT_BYTES / 1024} KB cannot be exported as a file.`,
    );
}

/**
 * The cheap checks, made on the API thread before any allowance is used:
 * there is text, it is within the size limit and, for a spreadsheet, it
 * appears to have a table (the line scan the web client uses). Parsing is
 * left to the worker: a dense 512 KB input takes markdown-it about half a
 * second, which must not block the event loop for a request that costs
 * nothing. The worker's parser still has the last word on tables.
 */
export function assertExportable(format: DocumentFormat, markdown: string): void {
  assertExportableText(markdown);
  if (format === 'xlsx' && !markdownHasTable(markdown)) throw validationFailed(NO_TABLES_TO_EXPORT);
}

/** Parsed content, checked for what the format needs. */
export async function prepareDocument(
  format: DocumentFormat,
  title: string,
  markdown: string,
  creator?: string,
) {
  assertExportableText(markdown);
  const { documentModel, hasTables } = await import('./model.js');
  const model = documentModel(title, markdown, creator);
  if (format === 'xlsx' && !hasTables(model.blocks)) throw validationFailed(NO_TABLES_TO_EXPORT);
  return model;
}

type PreparedDocument = Awaited<ReturnType<typeof prepareDocument>>;

export async function renderDocument(
  format: DocumentFormat,
  model: PreparedDocument,
  maxBytes = MAX_DOCUMENT_EXPORT_OUTPUT_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array;
  switch (format) {
    case 'docx':
      bytes = await (await import('./docx.js')).renderDocx(model);
      break;
    case 'pdf': {
      const { renderPdf, TooLargeError } = await import('./pdf.js');
      try {
        bytes = await renderPdf(model, maxBytes);
      } catch (error) {
        if (error instanceof TooLargeError) throw validationFailed(DOCUMENT_TOO_LARGE);
        throw error;
      }
      break;
    }
    case 'xlsx':
      bytes = (await import('./xlsx.js')).renderXlsx(model);
      break;
    case 'pptx':
      bytes = await (await import('./pptx.js')).renderPptx(model);
      break;
  }
  if (bytes.byteLength > maxBytes) throw validationFailed(DOCUMENT_TOO_LARGE);
  // Generators return plain (never shared) buffers.
  return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * `attachment` with the base name and the format's extension, as `filename*`
 * (UTF-8, so a Japanese or Arabic title survives, #361) and an ASCII `filename`.
 */
export function documentDisposition(base: string, format: DocumentFormat): string {
  return contentDisposition(`${base}.${DOCUMENT_FORMAT_INFO[format].extension}`);
}

interface WorkerLimits {
  timeoutMs: number;
  /** The worker's old-generation heap. */
  heapMb: number;
}

const WORKER_LIMITS: WorkerLimits = { timeoutMs: 60_000, heapMb: 512 };

interface WorkerResult {
  ok: boolean;
  buffer?: ArrayBuffer;
  status?: number;
  code?: string;
  message?: string;
}

const tooComplex = (format: DocumentFormat) =>
  validationFailed(
    `This content is too long or complex to export as ${DOCUMENT_FORMAT_INFO[format].description}. ` +
      'Export a shorter part, or choose another format.',
  );

/**
 * Generates a document in a worker thread. Running out of the worker's heap
 * or time is reported as content too large to export (422); other failures
 * are errors.
 */
export function renderInWorker(
  format: DocumentFormat,
  title: string,
  markdown: string,
  limits: WorkerLimits = WORKER_LIMITS,
  /** The instance name for the file's author/creator metadata. */
  creator?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  // Under tsx or Vitest this module is TypeScript; the worker then needs tsx too.
  const typescript = import.meta.url.endsWith('.ts');
  const worker = new Worker(
    new URL(`./render-worker.${typescript ? 'ts' : 'js'}`, import.meta.url),
    {
      workerData: { format, title, markdown, creator, maxBytes: MAX_DOCUMENT_EXPORT_OUTPUT_BYTES },
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMb },
      ...(typescript ? { execArgv: ['--import', 'tsx'] } : {}),
    },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(tooComplex(format))), limits.timeoutMs);
    worker.once('message', (result: WorkerResult) =>
      settle(() => {
        if (result.ok && result.buffer) resolve(new Uint8Array(result.buffer));
        else if (result.status && result.code)
          reject(
            new AppError(
              result.code as AppError['code'],
              result.message ?? 'Export failed',
              result.status as AppError['status'],
            ),
          );
        else reject(new Error(`Document generation failed: ${result.message ?? 'unknown error'}`));
      }),
    );
    worker.once('error', (error: Error & { code?: string }) =>
      settle(() => reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooComplex(format) : error)),
    );
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`The document worker stopped (exit code ${code})`))),
    );
  });
}
