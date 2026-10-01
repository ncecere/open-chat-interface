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
