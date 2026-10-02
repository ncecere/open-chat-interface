import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { ERROR_CODES } from '@oci/shared';
import busboy from 'busboy';
import { Hono } from 'hono';
import { loadEnv } from '../config/env.js';
import { clientIp } from '../lib/client-ip.js';
import { AppError, rateLimited, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { recordAudit } from '../services/audit.js';
import { consumeRateLimit } from '../services/limits/rate-limit.js';
import { exportArchive, exportArchiveFilename } from '../services/portability/export-archive.js';
import {
  assertNoActiveImport,
  createImport,
  deleteImport,
  listImports,
  scheduleImportProcessing,
  serializeImport,
} from '../services/portability/imports.js';

/**
 * Data portability for the signed-in person: a full export of everything they
 * own, and imports of their history from ChatGPT or Claude.
 *
 * Mounted under `/api/me` alongside the profile routes.
 */
export const portabilityRoutes = new Hono<AppBindings>();

portabilityRoutes.use('*', requireAuth);

/** Exports in progress on this replica. One at a time per person. */
const activeExports = new Set<string>();
/** An abandoned stream that never reports cancellation must not lock exports forever. */
const EXPORT_LOCK_MAX_MS = 60 * 60 * 1000;

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

const tooLarge = (maxBytes: number) =>
  new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    `The file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB import limit.`,
    413,
  );

/**
 * Downloads every conversation, its JSON record, and attached files as one
 * ZIP, streamed as it is written. Trashed and temporary chats are excluded.
 */
portabilityRoutes.get('/export', async (c) => {
  const user = currentUser(c);
  if (activeExports.has(user.id)) {
    throw rateLimited('An export is already downloading. Wait for it to finish.', 30);
  }
  const limit = await consumeRateLimit({
    bucket: 'export',
    identifier: user.id,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  if (!limit.allowed) {
    throw rateLimited(
      'Too many exports in the last hour. Try again later.',
      limit.retryAfterSeconds,
    );
  }

  activeExports.add(user.id);
  let released = false;
  const safety = setTimeout(() => release(), EXPORT_LOCK_MAX_MS);
  safety.unref();
  function release() {
    if (released) return;
    released = true;
    clearTimeout(safety);
    activeExports.delete(user.id);
  }

  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'user.export',
    targetType: 'user',
    targetId: user.id,
    ipAddress: clientIp(c),
  });

  const iterator = exportArchive({ id: user.id });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        logger.error({ error, userId: user.id }, 'Export failed while streaming');
        controller.error(error);
      }
    },
    async cancel() {
      release();
      await iterator.return(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${exportArchiveFilename()}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

/** The person's imports and their progress, newest first. */
portabilityRoutes.get('/imports', async (c) => {
  const user = currentUser(c);
  const rows = await listImports(user.id);
  return c.json({ imports: rows.map(serializeImport) });
});

interface ReceivedUpload {
  filename: string;
  path: string;
  sizeBytes: number;
}

/** Streams the multipart `file` field to a temporary file, enforcing the size limit. */
function receiveUpload(request: Request, maxBytes: number, path: string): Promise<ReceivedUpload> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !request.body) {
    throw validationFailed('Upload the export as a file in a form field named "file".');
  }

  return new Promise<ReceivedUpload>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: { 'content-type': contentType },
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 1024 },
      });
    } catch {
      reject(validationFailed('The upload could not be read.'));
      return;
    }

    let received: Promise<ReceivedUpload> | null = null;
    parser.on('file', (field, file, info) => {
      if (field !== 'file' || received) {
        file.resume();
        return;
      }
      let sizeBytes = 0;
      let truncated = false;
      file.on('limit', () => {
        truncated = true;
      });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.byteLength;
          callback(null, chunk);
        },
      });
      received = pipeline(file, counter, createWriteStream(path)).then(() => {
        if (truncated) throw tooLarge(maxBytes);
        if (sizeBytes === 0) throw validationFailed('The uploaded file is empty.');
        return { filename: info.filename || 'export', path, sizeBytes };
      });
      // Settled through `close`; this only prevents an unhandled rejection.
      received.catch(() => undefined);
    });
    parser.on('error', () => reject(validationFailed('The upload could not be read.')));
    parser.on('close', () => {
      if (!received) reject(validationFailed('No file was provided.'));
      else received.then(resolve, reject);
    });

    const body = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);
    body.on('error', () => reject(validationFailed('The upload was interrupted.')));
    body.pipe(parser);
  });
}

/**
 * Accepts a ChatGPT or Claude export (`.zip`, or the `conversations.json`
 * inside it) and queues it for background processing.
 */
portabilityRoutes.post('/imports', async (c) => {
  const user = currentUser(c);
  const maxBytes = loadEnv().IMPORT_MAX_UPLOAD_BYTES;

  const limit = await consumeRateLimit({
    bucket: 'import',
    identifier: user.id,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  if (!limit.allowed) {
    throw rateLimited(
      'Too many imports in the last hour. Try again later.',
      limit.retryAfterSeconds,
    );
  }

  const contentLength = Number(c.req.header('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
    throw tooLarge(maxBytes);
  }

  // Checked before reading the body so a second upload is refused without
  // transferring it; createImport repeats the check under the admission lock.
  await assertNoActiveImport(user.id);

  const directory = await mkdtemp(join(tmpdir(), 'oci-import-'));
  try {
    const upload = await receiveUpload(c.req.raw, maxBytes, join(directory, 'upload'));
    const row = await createImport({
      userId: user.id,
      role: user.role,
      organizationId: user.organizationId,
      filename: upload.filename,
      path: upload.path,
      sizeBytes: upload.sizeBytes,
    });

    await recordAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'user.import',
      targetType: 'conversation_import',
      targetId: row.id,
      metadata: { stage: 'queued', filename: row.filename, sizeBytes: upload.sizeBytes },
      ipAddress: clientIp(c),
    });
    scheduleImportProcessing();

    return c.json({ import: serializeImport(row) }, 202);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Removes a queued or finished import and its stored upload; 409 while it is running. */
portabilityRoutes.delete('/imports/:id', async (c) => {
  const user = currentUser(c);
  await deleteImport(c.req.param('id'), user.id);
  return c.json({ ok: true });
});
