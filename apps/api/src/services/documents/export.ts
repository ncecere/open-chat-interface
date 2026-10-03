import { and, eq, schema } from '@oci/db';
import { ARTIFACT_KIND_LABELS, DOCUMENT_FORMAT_INFO, type DocumentFormat } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound, rateLimited, validationFailed } from '../../lib/errors.js';
import { artifactVersionForExport, replyText } from '../artifacts/store.js';
import { activeMessage } from '../chat/reply-path.js';
import { safeTitleSlug } from '../export.js';
import { consumeRateLimit } from '../limits/rate-limit.js';
import { getOwnedThread } from '../threads.js';
import { assertExportable, documentDisposition, renderInWorker } from './render.js';

/**
 * File output (v0.9): a reply or a Markdown artifact as DOCX, PDF, XLSX or
 * PPTX. Owner only; everything else is 404, like any other read.
 *
 * Document exports and single-conversation Markdown downloads share one
 * hourly allowance per person. The full archive keeps its own, stricter one.
 */

export const FILE_EXPORTS_PER_HOUR = 60;
/** Documents generated at once on one replica (one per person). */
export const MAX_CONCURRENT_GENERATIONS = 2;

export async function consumeFileExport(userId: string): Promise<void> {
  const limit = await consumeRateLimit({
    bucket: 'export:file',
    identifier: userId,
    limit: FILE_EXPORTS_PER_HOUR,
    windowSeconds: 60 * 60,
  });
  if (!limit.allowed)
    throw rateLimited(
      'Too many downloads in the last hour. Try again later.',
      limit.retryAfterSeconds,
    );
}

const generating = new Set<string>();

/**
 * Runs one generation for a person. Each runs in a worker thread that may use
 * several hundred MB, so a replica prepares at most two documents at once and
 * each person one; anything more is asked to retry shortly.
 */
export async function withGenerationSlot<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (generating.has(userId))
    throw rateLimited('A file is already being prepared. Wait for it to finish.', 5);
  if (generating.size >= MAX_CONCURRENT_GENERATIONS)
    throw rateLimited('Files are being prepared for others. Try again in a moment.', 5);
  generating.add(userId);
  try {
    return await work();
  } finally {
    generating.delete(userId);
  }
}

interface DocumentFile {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  disposition: string;
}

async function generate(
  userId: string,
  format: DocumentFormat,
  source: { title: string; markdown: string },
  base: string,
): Promise<DocumentFile> {
  assertExportable(format, source.markdown);
  // The slot first: a request turned away because another is still being
  // prepared does not use the allowance.
  const bytes = await withGenerationSlot(userId, async () => {
    await consumeFileExport(userId);
    return renderInWorker(format, source.title, source.markdown);
  });
  return {
    bytes,
    contentType: DOCUMENT_FORMAT_INFO[format].mimeType,
    disposition: documentDisposition(base, format),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * An assistant reply on the conversation's active path, as a document titled
 * after the conversation. 404 for anyone but the owner, conversations in the
 * trash, user messages and replies a retry replaced; 409 while it is written.
 */
export async function exportReply(params: {
  userId: string;
  threadId: string;
  messageId: string;
  format: DocumentFormat;
}): Promise<DocumentFile & { threadId: string; messageId: string }> {
  const thread = await getOwnedThread(params.threadId, params.userId);
  const [message] = await db
    .select({
      id: schema.message.id,
      parts: schema.message.parts,
      status: schema.message.status,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.id, params.messageId),
        eq(schema.message.threadId, thread.id),
        eq(schema.message.role, 'assistant'),
        activeMessage(),
      ),
    )
    .limit(1);
  if (!message) throw notFound('Message not found');
  if (message.status === 'streaming')
    throw conflict('This reply is still being written. Export it once it has finished.');
  const file = await generate(
    params.userId,
    params.format,
    { title: thread.title, markdown: replyText(message.parts) },
    `${safeTitleSlug(thread.title)}-reply-${today()}`,
  );
  return { ...file, threadId: thread.id, messageId: message.id };
}

const ONLY_MARKDOWN_ARTIFACTS =
  'Only documents (Markdown artifacts) can be exported as files. Download HTML, SVG and Mermaid artifacts as they are.';

/** A Markdown artifact (the current version, or `version`) as a document. */
export async function exportArtifact(params: {
  userId: string;
  artifactId: string;
  version?: number;
  format: DocumentFormat;
}): Promise<DocumentFile & { threadId: string; artifactId: string; version: number }> {
  const artifact = await artifactVersionForExport(params.artifactId, params.userId, params.version);
  if (!artifact)
    throw notFound(
      params.version === undefined ? 'Artifact not found' : 'Artifact version not found',
    );
  if (artifact.kind !== 'markdown')
    throw validationFailed(
      `${ONLY_MARKDOWN_ARTIFACTS} (This one is ${ARTIFACT_KIND_LABELS[artifact.kind]}.)`,
    );
  const file = await generate(
    params.userId,
    params.format,
    { title: artifact.title, markdown: artifact.content },
    `${safeTitleSlug(artifact.title, 'document')}-v${artifact.version}`,
  );
  return {
    ...file,
    threadId: artifact.threadId,
    artifactId: artifact.id,
    version: artifact.version,
  };
}
