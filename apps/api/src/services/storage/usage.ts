import { and, eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';

export type StorageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Owner = { organizationId: string; userId: string };

/** Shared admission mutex. No storage I/O belongs inside this transaction. */
export async function lockStorageUsage(tx: StorageTransaction, owner: Owner): Promise<void> {
  await tx.insert(schema.storageUsage).values(owner).onConflictDoNothing();
  const [row] = await tx
    .select({ id: schema.storageUsage.id })
    .from(schema.storageUsage)
    .where(eq(schema.storageUsage.userId, owner.userId))
    .for('update');
  if (!row) throw new Error('Storage owner disappeared');
}

/** Include unfinished uploads: they reserve space until completed or explicitly removed. */
export async function attachmentTotals(tx: StorageTransaction, userId: string) {
  const [row] = await tx
    .select({
      liveBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is null), 0)::bigint`,
      liveFiles: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is null)::int`,
      pendingBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is not null), 0)::bigint`,
      pendingFiles: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is not null)::int`,
    })
    .from(schema.attachment)
    .where(eq(schema.attachment.userId, userId));
  return {
    liveBytes: Number(row?.liveBytes ?? 0),
    liveFileCount: Number(row?.liveFiles ?? 0),
    pendingBytes: Number(row?.pendingBytes ?? 0),
    pendingFileCount: Number(row?.pendingFiles ?? 0),
  };
}

type Reader = Pick<StorageTransaction, 'select'>;

/**
 * Bytes held by the person's artifact versions in conversations that are not
 * in the trash (v0.9). Summed from the rows rather than kept in a counter, so
 * cascading deletes (thread, account, retention) can never leave it stale.
 */
export async function artifactBytes(tx: Reader, userId: string): Promise<number> {
  const [row] = await tx
    .select({
      bytes: sql<number>`coalesce(sum(${schema.artifactVersion.sizeBytes}), 0)::bigint`,
    })
    .from(schema.artifactVersion)
    .innerJoin(schema.artifact, eq(schema.artifact.id, schema.artifactVersion.artifactId))
    .innerJoin(schema.thread, eq(schema.thread.id, schema.artifact.threadId))
    .where(and(eq(schema.artifact.userId, userId), sql`${schema.thread.deletedAt} is null`));
  return Number(row?.bytes ?? 0);
}

/** Bytes held by one conversation's artifact versions. */
export async function threadArtifactBytes(tx: Reader, threadId: string): Promise<number> {
  const [row] = await tx
    .select({
      bytes: sql<number>`coalesce(sum(${schema.artifactVersion.sizeBytes}), 0)::bigint`,
    })
    .from(schema.artifactVersion)
    .innerJoin(schema.artifact, eq(schema.artifact.id, schema.artifactVersion.artifactId))
    .where(eq(schema.artifact.threadId, threadId));
  return Number(row?.bytes ?? 0);
}

/**
 * What admission checks against: attachments (including reservations) plus
 * artifact versions. Artifacts add bytes, not files: the file-count limit is
 * about uploaded files.
 */
export async function admissionTotals(tx: StorageTransaction, userId: string) {
  const files = await attachmentTotals(tx, userId);
  const artifacts = await artifactBytes(tx, userId);
  return { ...files, liveBytes: files.liveBytes + artifacts };
}

/** Counters and the attachment mutation always commit together. */
export async function adjustStorageUsage(
  tx: Pick<StorageTransaction, 'insert'>,
  params: Owner & {
    liveBytes?: number;
    liveFiles?: number;
    pendingBytes?: number;
    pendingFiles?: number;
  },
): Promise<void> {
  const liveBytes = params.liveBytes ?? 0;
  const liveFiles = params.liveFiles ?? 0;
  const pendingBytes = params.pendingBytes ?? 0;
  const pendingFiles = params.pendingFiles ?? 0;
  await tx
    .insert(schema.storageUsage)
    .values({
      organizationId: params.organizationId,
      userId: params.userId,
      liveBytes: Math.max(0, liveBytes),
      liveFileCount: Math.max(0, liveFiles),
      pendingBytes: Math.max(0, pendingBytes),
      pendingFileCount: Math.max(0, pendingFiles),
    })
    .onConflictDoUpdate({
      target: schema.storageUsage.userId,
      set: {
        liveBytes: sql`greatest(0, ${schema.storageUsage.liveBytes} + ${liveBytes})`,
        liveFileCount: sql`greatest(0, ${schema.storageUsage.liveFileCount} + ${liveFiles})`,
        pendingBytes: sql`greatest(0, ${schema.storageUsage.pendingBytes} + ${pendingBytes})`,
        pendingFileCount: sql`greatest(0, ${schema.storageUsage.pendingFileCount} + ${pendingFiles})`,
        updatedAt: new Date(),
      },
    });
}

/** Lock before aggregating so a concurrent committed delta cannot be overwritten. */
export async function recomputeStorageUsage(): Promise<number> {
  const owners = await db.execute<{ organization_id: string; user_id: string }>(sql`
    select organization_id, user_id from attachment
    union select organization_id, user_id from storage_usage
    order by user_id
  `);
  for (const owner of owners) {
    await db.transaction(async (tx) => {
      // Parent first: account deletion must not race creation of its usage row.
      const [user] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, owner.user_id))
        .for('key share');
      if (!user) return;
      await lockStorageUsage(tx, { organizationId: owner.organization_id, userId: owner.user_id });
      const totals = await attachmentTotals(tx, owner.user_id);
      await tx
        .update(schema.storageUsage)
        .set({ ...totals, updatedAt: new Date() })
        .where(
          and(
            eq(schema.storageUsage.userId, owner.user_id),
            eq(schema.storageUsage.organizationId, owner.organization_id),
          ),
        );
    });
  }
  return owners.length;
}
