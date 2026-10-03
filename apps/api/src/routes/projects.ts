import {
  createProjectSchema,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
  updateProjectSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { rateLimited, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { assertAttachmentUseAllowed } from '../services/attachments/index.js';
import { uploadRateLimit } from '../services/limits/rate-limit.js';
import {
  assertProjectsAllowed,
  createProject,
  deleteProject,
  deleteProjectFile,
  getOwnedProject,
  getProjectSummary,
  listProjectFiles,
  listProjects,
  listSidebarProjects,
  serializeProjectFile,
  updateProject,
  uploadProjectFile,
} from '../services/projects.js';
import { getSetting } from '../services/settings.js';

/**
 * A signed-in person's own projects. Every route needs the role's `projects`
 * feature (403 otherwise); a project that is not the caller's is a 404.
 *
 * With the feature switched off, existing projects are kept but cannot be
 * read or changed here, and their instructions and files stop being added to
 * conversations (see services/chat/project-context.ts).
 */
export const projectRoutes = new Hono<AppBindings>();

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const HARD_UPLOAD_REQUEST_LIMIT =
  DEFAULT_MAX_FILE_BYTES * DEFAULT_MAX_FILES_PER_MESSAGE + MULTIPART_OVERHEAD_BYTES;

projectRoutes.use('*', requireAuth);
projectRoutes.use('*', async (c, next) => {
  await assertProjectsAllowed(currentUser(c).role);
  await next();
});

/** The signed-in person's projects by name, with conversation and file counts. */
projectRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json({ projects: await listProjects(user.id) });
});

/**
 * The sidebar's project tree: each project with its conversation count and up to five newest unpinned conversations.
 *
 * A separate path rather than a heavier GET /: the project picker and other
 * callers do not need the conversations. Declared before `/:id`.
 */
projectRoutes.get('/sidebar', async (c) => {
  const user = currentUser(c);
  return c.json({ projects: await listSidebarProjects(user.id) });
});

/** Creates a project, up to the per-person limit. */
projectRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, createProjectSchema);
  const project = await createProject({
    userId: user.id,
    organizationId: user.organizationId,
    input,
  });
  return c.json({ project }, 201);
});

/** One of the person's projects; 404 for anyone else's. */
projectRoutes.get('/:id', async (c) => {
  const user = currentUser(c);
  return c.json({ project: await getProjectSummary(c.req.param('id'), user.id) });
});

/** Renames a project or changes its instructions; only the sent fields change. */
projectRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  const patch = await parseBody(c, updateProjectSchema);
  return c.json({ project: await updateProject(c.req.param('id'), user.id, patch) });
});

/** Conversations are detached and kept; files are deleted and their storage released. */
projectRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  const result = await deleteProject(c.req.param('id'), user.id);
  return c.json({ ok: true, ...result });
});

/** The project's files, oldest first. */
projectRoutes.get('/:id/files', async (c) => {
  const user = currentUser(c);
  return c.json({ files: await listProjectFiles(c.req.param('id'), user.id) });
});

/**
 * Uploads through the same validation and storage path as chat attachments,
 * so it also needs attachments to be allowed for the role and the instance,
 * shares the upload rate limit, and counts against the storage allowance.
 */
projectRoutes.post(
  '/:id/files',
  bodyLimit({
    maxSize: HARD_UPLOAD_REQUEST_LIMIT,
    onError: (c) =>
      c.json({ error: { code: 'VALIDATION_FAILED', message: 'Upload request is too large' } }, 413),
  }),
  async (c) => {
    const user = currentUser(c);
    const projectId = c.req.param('id');
    await getOwnedProject(projectId, user.id);
    await assertAttachmentUseAllowed(user.role);

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
        await uploadProjectFile({
          userId: user.id,
          role: user.role,
          projectId,
          filename: file.name ?? 'file',
          declaredMimeType: file.type ?? 'application/octet-stream',
          bytes: Buffer.from(await file.arrayBuffer()),
        }),
      );
    }

    return c.json({ files: uploaded.map(serializeProjectFile) }, 201);
  },
);

/** Removes the file outright; its storage is released immediately. */
projectRoutes.delete('/:id/files/:fileId', async (c) => {
  const user = currentUser(c);
  await deleteProjectFile(c.req.param('id'), c.req.param('fileId'), user.id);
  return c.json({ ok: true });
});
