import { schema, sql } from '@oci/db';
import type { ArtifactSummary, ArtifactVersionSummary } from '@oci/shared';
import type { getStorageLimits } from '../storage/quota.js';
import type { StorageTransaction } from '../storage/usage.js';

export type Transaction = StorageTransaction;
export type ArtifactRow = typeof schema.artifact.$inferSelect;
export type Limits = Awaited<ReturnType<typeof getStorageLimits>>;

/** The artifact's conversation is not in the trash; trashed conversations are invisible. */
export const inLiveThread = () =>
  sql`exists (select 1 from ${schema.thread} where ${schema.thread.id} = ${schema.artifact.threadId} and ${schema.thread.deletedAt} is null)`;

export function serializeArtifact(row: ArtifactRow, sizeBytes: number): ArtifactSummary {
  return {
    id: row.id,
    threadId: row.threadId,
    messageId: row.messageId,
    sourceKey: row.sourceKey,
    title: row.title,
    kind: row.kind,
    currentVersion: row.currentVersion,
    sizeBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeVersion(
  row: Pick<
    typeof schema.artifactVersion.$inferSelect,
    'version' | 'sizeBytes' | 'source' | 'messageId' | 'createdAt'
  >,
): ArtifactVersionSummary {
  return {
    version: row.version,
    sizeBytes: row.sizeBytes,
    source: row.source,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
  };
}
