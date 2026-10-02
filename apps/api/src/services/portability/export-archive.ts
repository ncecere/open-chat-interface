import { and, asc, desc, eq, inArray, isNull, schema } from '@oci/db';
import { EXPORT_ARCHIVE_VERSION } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { artifactsWithVersions } from '../artifacts/store.js';
import { activeMessage } from '../chat/reply-path.js';
import { exportableParts, MAX_EXPORT_MESSAGES, renderMarkdown, safeTitleSlug } from '../export.js';
import { getStorageDriver } from '../storage/index.js';
import { NameAllocator, safeEntrySegment, ZIP_MAX_ENTRIES, ZipStreamWriter } from './zip-writer.js';

interface ExportLimits {
  /** Attachment bytes included before further files are listed but left out. */
  maxAttachmentBytes: number;
  /** Conversations included; more are reported as truncated. */
  maxConversations: number;
  /** Messages per conversation in its JSON file. */
  maxMessagesPerConversation: number;
}

/**
 * Bounds that keep a plain (non-ZIP64) archive valid and a single download
 * reasonable. Anything left out is named in the manifest, never dropped quietly.
 */
const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxAttachmentBytes: 2 * 1024 * 1024 * 1024,
  maxConversations: 20_000,
  maxMessagesPerConversation: 50_000,
};

type ThreadRow = typeof schema.thread.$inferSelect;
type AttachmentRow = Pick<
  typeof schema.attachment.$inferSelect,
  'id' | 'messageId' | 'filename' | 'mimeType' | 'sizeBytes' | 'storageKey' | 'createdAt'
>;

interface ExportedAttachment {
  id: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Location inside the archive, or null when the bytes were left out. */
  path: string | null;
  omittedReason?: 'missing' | 'size-limit' | 'entry-limit';
}

interface ExportSummary {
  conversations: number;
  memories: number;
  projects: number;
  messages: number;
  attachments: number;
  attachmentBytes: number;
  omittedAttachments: number;
  truncated: boolean;
}

function threadSummary(thread: ThreadRow) {
  return {
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned,
    archived: thread.archived,
    parentThreadId: thread.parentThreadId,
    branchedFromMessageId: thread.branchedFromMessageId,
    projectId: thread.projectId,
    importSource: thread.importSource,
    importSourceId: thread.importSourceId,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

function serializeMessage({
  supersededAt: _supersededAt,
  ...message
}: typeof schema.message.$inferSelect) {
  return {
    ...message,
    parts: exportableParts(message.parts),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

/** Maps each id to its stem, adding -2, -3… so no two are equal ignoring case. */
function uniqueNames<T extends { id: string }>(
  items: T[],
  stem: (item: T) => string,
): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const item of items) {
    const base = stem(item);
    let candidate = base;
    for (let counter = 2; used.has(candidate.toLowerCase()); counter += 1) {
      candidate = `${base}-${counter}`;
    }
    used.add(candidate.toLowerCase());
    names.set(item.id, candidate);
  }
  return names;
}

/** Conversation file stems: readable and dated. */
const conversationNames = (threads: ThreadRow[]) =>
  uniqueNames(
    threads,
    (thread) => `${safeTitleSlug(thread.title)}-${thread.createdAt.toISOString().slice(0, 10)}`,
  );

/** Threads the export covers: live and archived, never trashed or temporary. */
async function exportableThreads(userId: string, limit: number) {
  return db
    .select()
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.userId, userId),
        eq(schema.thread.temporary, false),
        isNull(schema.thread.deletedAt),
      ),
    )
    .orderBy(asc(schema.thread.createdAt), asc(schema.thread.id))
    .limit(limit);
}

/** Ready, live attachments owned by this person on the given messages. */
async function attachmentsForMessages(
  userId: string,
  messageIds: string[],
): Promise<AttachmentRow[]> {
  if (messageIds.length === 0) return [];
  const rows: AttachmentRow[] = [];
  // Bounded IN-lists keep a very long conversation from building a huge query.
  for (let index = 0; index < messageIds.length; index += 1_000) {
    rows.push(
      ...(await db
        .select({
          id: schema.attachment.id,
          messageId: schema.attachment.messageId,
          filename: schema.attachment.filename,
          mimeType: schema.attachment.mimeType,
          sizeBytes: schema.attachment.sizeBytes,
          storageKey: schema.attachment.storageKey,
          createdAt: schema.attachment.createdAt,
        })
        .from(schema.attachment)
        .where(
          and(
            eq(schema.attachment.userId, userId),
            inArray(schema.attachment.messageId, messageIds.slice(index, index + 1_000)),
            isNull(schema.attachment.deletedAt),
            eq(schema.attachment.uploadPending, false),
          ),
        )
        .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))),
    );
  }
  return rows;
}

const attachmentColumns = {
  id: schema.attachment.id,
  messageId: schema.attachment.messageId,
  filename: schema.attachment.filename,
  mimeType: schema.attachment.mimeType,
  sizeBytes: schema.attachment.sizeBytes,
  storageKey: schema.attachment.storageKey,
  createdAt: schema.attachment.createdAt,
};

/** A project's ready files, oldest first. */
async function projectAttachments(userId: string, projectId: string): Promise<AttachmentRow[]> {
  return db
    .select(attachmentColumns)
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.projectId, projectId),
        isNull(schema.attachment.deletedAt),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
}

/** Project folder names: readable. */
const projectFolderNames = (projects: Array<{ id: string; name: string }>) =>
  uniqueNames(projects, (project) => safeTitleSlug(project.name, 'project'));

/** Uploaded but never sent: still the person's files, so they belong in the export. */
async function unsentAttachments(userId: string): Promise<AttachmentRow[]> {
  return db
    .select({
      id: schema.attachment.id,
      messageId: schema.attachment.messageId,
      filename: schema.attachment.filename,
      mimeType: schema.attachment.mimeType,
      sizeBytes: schema.attachment.sizeBytes,
      storageKey: schema.attachment.storageKey,
      createdAt: schema.attachment.createdAt,
    })
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.userId, userId),
        isNull(schema.attachment.messageId),
        // Project files are exported with their project.
        isNull(schema.attachment.projectId),
        isNull(schema.attachment.deletedAt),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id));
}

const COMPRESSED_TYPES = /^(image\/(png|jpe?g|gif|webp)|application\/(zip|pdf|gzip))/;

function readme(summary: ExportSummary, createdAt: Date): string {
  return [
    'Open Chat Interface export',
    '==========================',
    '',
    `Created ${createdAt.toISOString()} by Open Chat Interface ${APP_VERSION}.`,
    '',
    'conversations/   One Markdown file (readable) and one JSON file (complete)',
    '                 per conversation, including archived ones. Conversations',
    '                 in the trash and temporary chats are not included.',
    '                 Markdown leaves out model reasoning; the JSON keeps it.',
    '                 Artifacts (with every version) are in the JSON; the',
    '                 Markdown names them.',
    'attachments/     Files you attached, in a folder per conversation.',
    '                 Files uploaded but never sent are under attachments/unsent/.',
    "projects/        Each project's files, in a folder per project. Project names",
    '                 and instructions are in manifest.json.',
    'memory.json      What OCI remembers about you (Settings > Memory), newest',
    '                 first, whether or not memory is switched on.',
    'manifest.json    Counts, versions, and an index of every conversation.',
    '',
    `Conversations: ${summary.conversations}`,
    `Projects: ${summary.projects}`,
    `Memories: ${summary.memories}`,
    `Messages: ${summary.messages}`,
    `Attachments: ${summary.attachments}`,
    summary.omittedAttachments > 0
      ? `Attachments left out: ${summary.omittedAttachments} (see manifest.json for which and why)`
      : '',
    summary.truncated
      ? 'This export was truncated at its size limits; see manifest.json for details.'
      : '',
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

/**
 * Streams everything a person owns as a ZIP archive.
 *
 * Pull-based: each `next()` writes one more file, so the archive is never held
 * in memory and a disconnected client stops the work. Every query is scoped
 * to the owner, including attachments, which are additionally matched to the
 * exported messages so a trashed or temporary conversation's files stay out.
 */
export async function* exportArchive(
  owner: { id: string },
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): AsyncGenerator<Uint8Array> {
  const createdAt = new Date();
  const writer = new ZipStreamWriter();
  const driver = await getStorageDriver();
  const threads = await exportableThreads(owner.id, limits.maxConversations + 1);
  const truncatedConversations = threads.length > limits.maxConversations;
  if (truncatedConversations) threads.length = limits.maxConversations;

  const names = conversationNames(threads);
  const summary: ExportSummary = {
    conversations: 0,
    memories: 0,
    projects: 0,
    messages: 0,
    attachments: 0,
    attachmentBytes: 0,
    omittedAttachments: 0,
    truncated: truncatedConversations,
  };
  const index: Array<Record<string, unknown>> = [];
  const omitted: Array<{ id: string; filename: string; reason: string }> = [];
  // Room for the manifest, README, memory file and the remaining conversation files.
  const entryBudget = () => ZIP_MAX_ENTRIES - writer.entries - 3;

  async function* writeAttachments(
    directory: string,
    rows: AttachmentRow[],
  ): AsyncGenerator<Uint8Array, ExportedAttachment[]> {
    const allocator = new NameAllocator();
    const exported: ExportedAttachment[] = [];
    for (const row of rows) {
      const entry: ExportedAttachment = {
        id: row.id,
        messageId: row.messageId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt.toISOString(),
        path: null,
      };
      exported.push(entry);

      if (summary.attachmentBytes + row.sizeBytes > limits.maxAttachmentBytes) {
        entry.omittedReason = 'size-limit';
      } else if (entryBudget() <= 0) {
        entry.omittedReason = 'entry-limit';
      } else {
        let bytes: Buffer | null = null;
        try {
          bytes = await driver.get(row.storageKey);
        } catch (error) {
          logger.warn({ error, attachmentId: row.id }, 'Export skipped a missing attachment');
          entry.omittedReason = 'missing';
        }
        if (bytes) {
          const path = `${directory}/${allocator.allocate(safeEntrySegment(row.filename))}`;
          writer.add(path, bytes, {
            compress: !COMPRESSED_TYPES.test(row.mimeType),
            mtime: row.createdAt,
          });
          entry.path = path;
          summary.attachments += 1;
          summary.attachmentBytes += bytes.byteLength;
          yield* writer.drain();
        }
      }

      if (entry.omittedReason) {
        summary.omittedAttachments += 1;
        if (entry.omittedReason !== 'missing') summary.truncated = true;
        omitted.push({ id: row.id, filename: row.filename, reason: entry.omittedReason });
      }
    }
    return exported;
  }

  for (const thread of threads) {
    if (entryBudget() < 2) {
      summary.truncated = true;
      break;
    }
    const name = names.get(thread.id) as string;
    const messages = await db
      .select()
      .from(schema.message)
      // Only the active reply of a retried turn, as in the single-thread export.
      .where(
        and(
          eq(schema.message.threadId, thread.id),
          eq(schema.message.userId, owner.id),
          activeMessage(),
        ),
      )
      .orderBy(asc(schema.message.position), asc(schema.message.createdAt))
      .limit(limits.maxMessagesPerConversation + 1);
    const truncatedMessages = messages.length > limits.maxMessagesPerConversation;
    if (truncatedMessages) {
      messages.length = limits.maxMessagesPerConversation;
      summary.truncated = true;
    }

    const attachments = yield* writeAttachments(
      `attachments/${name}`,
      await attachmentsForMessages(
        owner.id,
        messages.map((message) => message.id),
      ),
    );

    // Summaries made when the conversation outgrew its model, oldest first.
    // Messages are never changed by them, so the transcript above is complete.
    const compactions = await db
      .select()
      .from(schema.conversationCompaction)
      .where(
        and(
          eq(schema.conversationCompaction.threadId, thread.id),
          eq(schema.conversationCompaction.userId, owner.id),
        ),
      )
      .orderBy(asc(schema.conversationCompaction.createdAt), asc(schema.conversationCompaction.id));

    // Artifacts the exported replies created, with every version (v0.9).
    const artifacts = await artifactsWithVersions(
      thread.id,
      owner.id,
      messages.map((message) => message.id),
    );

    const markdownPath = `conversations/${name}.md`;
    const jsonPath = `conversations/${name}.json`;
    writer.add(
      markdownPath,
      renderMarkdown(thread, messages.slice(0, MAX_EXPORT_MESSAGES), artifacts),
      {
        mtime: thread.updatedAt,
      },
    );
    writer.add(
      jsonPath,
      JSON.stringify(
        {
          exportVersion: EXPORT_ARCHIVE_VERSION,
          thread: threadSummary(thread),
          messages: messages.map(serializeMessage),
          attachments,
          compactions: compactions.map((compaction) => ({
            id: compaction.id,
            firstKeptMessageId: compaction.firstKeptMessageId,
            summary: compaction.summary,
            reason: compaction.reason,
            messagesSummarized: compaction.messagesSummarized,
            tokensSummarized: compaction.tokensSummarized,
            modelSlug: compaction.modelSlug,
            tokensIn: compaction.tokensIn,
            tokensOut: compaction.tokensOut,
            createdAt: compaction.createdAt.toISOString(),
          })),
          artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            messageId: artifact.messageId,
            sourceKey: artifact.sourceKey,
            title: artifact.title,
            kind: artifact.kind,
            currentVersion: artifact.currentVersion,
            createdAt: artifact.createdAt.toISOString(),
            updatedAt: artifact.updatedAt.toISOString(),
            versions: artifact.versions.map((version) => ({
              version: version.version,
              content: version.content,
              sizeBytes: version.sizeBytes,
              source: version.source,
              messageId: version.messageId,
              createdAt: version.createdAt.toISOString(),
            })),
          })),
          truncatedMessages,
        },
        null,
        2,
      ),
      { mtime: thread.updatedAt },
    );
    yield* writer.drain();

    summary.conversations += 1;
    summary.messages += messages.length;
    index.push({
      id: thread.id,
      title: thread.title,
      archived: thread.archived,
      projectId: thread.projectId,
      messages: messages.length,
      markdown: markdownPath,
      json: jsonPath,
    });
  }

  const unsent = yield* writeAttachments('attachments/unsent', await unsentAttachments(owner.id));

  // Projects: name, instructions and files. Conversations point back through
  // their `projectId`; a project's files sit under projects/<name>/.
  const projects = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.userId, owner.id))
    .orderBy(asc(schema.project.createdAt), asc(schema.project.id));
  const projectFolders = projectFolderNames(projects);
  const exportedConversations = new Set(index.map((entry) => entry.id));
  const projectIndex: Array<Record<string, unknown>> = [];
  for (const project of projects) {
    const folder = `projects/${projectFolders.get(project.id) as string}`;
    const files = yield* writeAttachments(folder, await projectAttachments(owner.id, project.id));
    projectIndex.push({
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      folder,
      conversations: threads
        .filter((thread) => thread.projectId === project.id && exportedConversations.has(thread.id))
        .map((thread) => thread.id),
      files,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    });
    summary.projects += 1;
  }

  // Memories (v0.9): every entry, newest first, whatever the switches say:
  // the person's data is theirs to take even after memory was switched off.
  const memories = await db
    .select()
    .from(schema.userMemory)
    .where(eq(schema.userMemory.userId, owner.id))
    .orderBy(desc(schema.userMemory.updatedAt), desc(schema.userMemory.id));
  summary.memories = memories.length;
  writer.add(
    'memory.json',
    JSON.stringify(
      {
        exportVersion: EXPORT_ARCHIVE_VERSION,
        memories: memories.map((memory) => ({
          id: memory.id,
          content: memory.content,
          source: memory.source,
          threadId: memory.threadId,
          messageId: memory.messageId,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        })),
      },
      null,
      2,
    ),
  );

  writer.add(
    'manifest.json',
    JSON.stringify(
      {
        exportVersion: EXPORT_ARCHIVE_VERSION,
        generator: 'open-chat-interface',
        ociVersion: APP_VERSION,
        createdAt: createdAt.toISOString(),
        counts: {
          conversations: summary.conversations,
          projects: summary.projects,
          memories: summary.memories,
          messages: summary.messages,
          attachments: summary.attachments,
          attachmentBytes: summary.attachmentBytes,
          omittedAttachments: summary.omittedAttachments,
        },
        truncated: summary.truncated,
        excluded: ['trashed conversations', 'temporary chats', 'deleted attachments'],
        conversations: index,
        projects: projectIndex,
        unsentAttachments: unsent,
        omittedAttachments: omitted,
      },
      null,
      2,
    ),
  );
  writer.add('README.txt', readme(summary, createdAt));
  writer.end();
  yield* writer.drain();
}

/** File name offered to the browser for a full export. */
export function exportArchiveFilename(now = new Date()): string {
  return `oci-export-${now.toISOString().slice(0, 10)}.zip`;
}
