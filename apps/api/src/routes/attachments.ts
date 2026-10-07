import {
  contentDisposition,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
} from '@oci/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { rateLimited, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import {
  assertAttachmentUseAllowed,
  deleteAttachment,
  discardUnsentAttachment,
  getOwnedAttachment,
  listAttachments,
  uploadAttachment,
} from '../services/attachments/index.js';
import { uploadRateLimit } from '../services/limits/rate-limit.js';
import { getSetting } from '../services/settings.js';
import { getStorageDriver } from '../services/storage/index.js';
import { getStorageUsage } from '../services/storage/quota.js';

export const attachmentRoutes = new Hono<AppBindings>();

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const HARD_UPLOAD_REQUEST_LIMIT =
  DEFAULT_MAX_FILE_BYTES * DEFAULT_MAX_FILES_PER_MESSAGE + MULTIPART_OVERHEAD_BYTES;

attachmentRoutes.use('*', requireAuth);

/** Consumption and the role's allowance, for the storage meter in settings. */
attachmentRoutes.get('/usage', async (c) => {
  const user = currentUser(c);
  return c.json(await getStorageUsage(user.id, user.role));
});

/** Chat files and project files (labelled with their project), newest first, at most 500. */
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
      // A project file is managed (and deleted) from its project.
      project: row.projectId ? { id: row.projectId, name: row.projectName ?? 'Project' } : null,
      // Uploaded in a chat and not sent (yet): in a composer now (#297).
      unsent: !row.projectId && !row.messageId,
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

    // Uploads are the fastest way to consume storage, so they carry their own
    // limit rather than sharing the chat budget.
    const limit = await uploadRateLimit(user.id, user.role);
    if (!limit.allowed) {
      throw rateLimited(
        'You are uploading too quickly. Try again in a moment.',
        limit.retryAfterSeconds,
      );
    }

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
          role: user.role,
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
    'content-disposition': contentDisposition(row.filename, 'inline'),
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
});

/**
 * Discards an upload the composer is leaving behind unsent (#297): New Chat,
 * or another conversation, with files attached and not sent. A file sent
 * meanwhile is kept (`removed: false`).
 */
attachmentRoutes.delete('/:id/unsent', async (c) => {
  const user = currentUser(c);
  return c.json({ removed: await discardUnsentAttachment(c.req.param('id'), user.id) });
});

attachmentRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await deleteAttachment(c.req.param('id'), user.id);
  return c.json({ ok: true });
});
