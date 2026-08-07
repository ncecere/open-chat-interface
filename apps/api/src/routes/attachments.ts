import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES_PER_MESSAGE } from '@oci/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import {
  assertAttachmentUseAllowed,
  deleteAttachment,
  getOwnedAttachment,
  listAttachments,
  uploadAttachment,
} from '../services/attachments/index.js';
import { getSetting } from '../services/settings.js';
import { getStorageDriver } from '../services/storage/index.js';

export const attachmentRoutes = new Hono<AppBindings>();

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const HARD_UPLOAD_REQUEST_LIMIT =
  DEFAULT_MAX_FILE_BYTES * DEFAULT_MAX_FILES_PER_MESSAGE + MULTIPART_OVERHEAD_BYTES;

attachmentRoutes.use('*', requireAuth);

attachmentRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const rows = await listAttachments(user.id);

  return c.json({
    attachments: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      url: `/api/attachments/${row.id}/content`,
      thumbnailUrl: null,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

attachmentRoutes.post(
  '/',
  bodyLimit({
    maxSize: HARD_UPLOAD_REQUEST_LIMIT,
    onError: (c) =>
      c.json({ error: { code: 'VALIDATION_FAILED', message: 'Upload request is too large' } }, 413),
  }),
  async (c) => {
    const user = currentUser(c);
    await assertAttachmentUseAllowed(user.role);

    const storage = await getSetting('storage');
    const configuredRequestLimit =
      storage.maxFileBytes * storage.maxFilesPerMessage + MULTIPART_OVERHEAD_BYTES;
    const contentLength = Number(c.req.header('content-length'));
    if (Number.isFinite(contentLength) && contentLength > configuredRequestLimit) {
      throw validationFailed('Upload request exceeds the configured file limits');
    }

    const form = await c.req.formData();

    // Node and undici disagree on the File type, so narrow structurally.
    interface UploadedFile {
      name?: string;
      type?: string;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }

    const files = form.getAll('files').flatMap((entry) => {
      const candidate = entry as unknown as UploadedFile;
      return typeof candidate === 'object' && typeof candidate?.arrayBuffer === 'function'
        ? [candidate]
        : [];
    });

    if (files.length === 0) throw validationFailed('No files were provided');

    if (files.length > storage.maxFilesPerMessage) {
      throw validationFailed(`At most ${storage.maxFilesPerMessage} files can be uploaded at once`);
    }

    const uploaded = [];
    for (const file of files) {
      uploaded.push(
        await uploadAttachment({
          userId: user.id,
          filename: file.name ?? 'file',
          declaredMimeType: file.type ?? 'application/octet-stream',
          bytes: Buffer.from(await file.arrayBuffer()),
        }),
      );
    }

    return c.json({ attachments: uploaded }, 201);
  },
);

/** Files are streamed through the API so ownership is always enforced. */
attachmentRoutes.get('/:id/content', async (c) => {
  const user = currentUser(c);
  const row = await getOwnedAttachment(c.req.param('id'), user.id);
  const driver = await getStorageDriver();
  const bytes = await driver.get(row.storageKey);

  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': row.mimeType,
    'content-length': String(bytes.byteLength),
    'content-disposition': `inline; filename="${encodeURIComponent(row.filename)}"`,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
});

attachmentRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteAttachment(c.req.param('id'), user.id);
  return c.json({ ok: true });
});
