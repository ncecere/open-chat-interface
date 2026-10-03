import { parentPort, workerData } from 'node:worker_threads';
import type { DocumentFormat } from '@oci/shared';
import { AppError } from '../../lib/errors.js';
import { prepareDocument, renderDocument } from './render.js';

/**
 * Worker-thread entry for document generation (see `renderInWorker`): parses
 * and renders one document, then posts the file (or the error) back once.
 */

const job = workerData as {
  format: DocumentFormat;
  title: string;
  markdown: string;
  maxBytes: number;
};

try {
  const model = await prepareDocument(job.format, job.title, job.markdown);
  // A fresh, exactly sized buffer, so it can be transferred rather than copied.
  const bytes = new Uint8Array(await renderDocument(job.format, model, job.maxBytes));
  parentPort?.postMessage({ ok: true, buffer: bytes.buffer }, [bytes.buffer]);
} catch (error) {
  parentPort?.postMessage(
    error instanceof AppError
      ? { ok: false, status: error.status, code: error.code, message: error.message }
      : { ok: false, message: error instanceof Error ? error.message : String(error) },
  );
}
