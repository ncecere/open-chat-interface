import { randomUUID } from 'node:crypto';
import { schema } from '@oci/db';
import { db } from '../../db/index.js';
import { isConnectionError } from '../../lib/db-connection.js';
import { logger } from '../../lib/logger.js';
import {
  detectConversationSource,
  type ImportedConversation,
  type ImportedSource,
  mapChatGptConversation,
  mapClaudeConversation,
} from './import-mappers.js';
import type { ImportRow } from './import-queue.js';

const MESSAGE_BATCH = 500;

export interface Progress {
  imported: number;
  skipped: number;
  failed: number;
  unknown: Record<string, number>;
  sources: Record<ImportedSource, number>;
  claudeBlocks: boolean;
}

/**
 * Writes one conversation and its messages in a single transaction.
 *
 * The partial unique index on (user, source, source id) makes this idempotent:
 * a conversation imported before, or still in the trash, is skipped rather
 * than duplicated or overwritten, so messages added here since are never lost.
 */
async function insertImportedConversation(
  owner: { userId: string; organizationId: string },
  conversation: ImportedConversation,
): Promise<'imported' | 'skipped'> {
  const createdAt = conversation.createdAt ?? new Date();
  const lastMessageAt = conversation.messages.at(-1)?.createdAt ?? conversation.updatedAt;
  const updatedAt = conversation.updatedAt ?? lastMessageAt ?? createdAt;

  return db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(schema.thread)
      .values({
        organizationId: owner.organizationId,
        userId: owner.userId,
        title: conversation.title,
        importSource: conversation.source,
        importSourceId: conversation.sourceId,
        lastMessageAt: lastMessageAt ?? updatedAt,
        createdAt,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.thread.id });
    if (!thread) return 'skipped';

    let promptId: string | null = null;
    const rows = conversation.messages.map((message, position) => {
      const id = randomUUID();
      const parentMessageId = message.role === 'assistant' ? promptId : null;
      if (message.role === 'user') promptId = id;
      const at = message.createdAt ?? createdAt;
      return {
        id,
        threadId: thread.id,
        userId: owner.userId,
        role: message.role,
        parts: message.parts,
        position,
        parentMessageId,
        modelSlug: message.modelSlug,
        // Imported turns are history, not generations: no usage, always complete.
        status: 'complete' as const,
        createdAt: at,
        updatedAt: at,
      };
    });
    for (let index = 0; index < rows.length; index += MESSAGE_BATCH) {
      await tx.insert(schema.message).values(rows.slice(index, index + MESSAGE_BATCH));
    }
    return 'imported';
  });
}

export async function applyConversation(row: ImportRow, value: unknown, progress: Progress) {
  const source = detectConversationSource(value);
  if (!source) {
    progress.failed += 1;
    progress.unknown['unrecognised-conversation'] =
      (progress.unknown['unrecognised-conversation'] ?? 0) + 1;
    return;
  }
  progress.sources[source] += 1;
  const mapped =
    source === 'chatgpt' ? mapChatGptConversation(value) : mapClaudeConversation(value);
  if (mapped.usedContentBlocks) progress.claudeBlocks = true;
  for (const type of mapped.unknownTypes) {
    progress.unknown[type] = (progress.unknown[type] ?? 0) + 1;
  }
  if (!mapped.conversation) {
    if (mapped.reason === 'empty') progress.skipped += 1;
    else progress.failed += 1;
    return;
  }
  try {
    const outcome = await insertImportedConversation(
      { userId: row.userId, organizationId: row.organizationId },
      mapped.conversation,
    );
    if (outcome === 'imported') progress.imported += 1;
    else progress.skipped += 1;
  } catch (error) {
    // The database went away (a failover), not this conversation: stop the
    // whole import, to be resumed, rather than count the rest as failed.
    if (isConnectionError(error)) throw error;
    progress.failed += 1;
    logger.warn(
      { error, importId: row.id, sourceId: mapped.conversation.sourceId },
      'Failed to import one conversation',
    );
  }
}

export function detectedSource(progress: Progress): 'chatgpt' | 'claude' | 'unknown' {
  if (progress.sources.chatgpt === 0 && progress.sources.claude === 0) return 'unknown';
  return progress.sources.chatgpt >= progress.sources.claude ? 'chatgpt' : 'claude';
}

/** ChatGPT's 2026 layout splits files and adds a manifest; Claude's adds content blocks. */
export function formatVersion(
  source: 'chatgpt' | 'claude' | 'unknown',
  entries: string[],
  claudeBlocks: boolean,
): string | null {
  const names = entries.map((entry) => entry.toLowerCase());
  if (source === 'chatgpt') {
    return names.some(
      (name) =>
        /conversations-\d+\.json$/.test(name) ||
        name.endsWith('export_manifest.json') ||
        name.endsWith('conversation_asset_file_names.json'),
    )
      ? 'v2'
      : 'v1';
  }
  if (source === 'claude') {
    return claudeBlocks ||
      names.some(
        (name) => name.includes('design_chats/') || /(^|\/)projects\/[^/]+\.json$/.test(name),
      )
      ? 'v2'
      : 'v1';
  }
  return null;
}
