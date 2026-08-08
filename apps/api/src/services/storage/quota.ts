import { and, eq, schema, sql } from '@oci/db';
import {
  DEFAULT_MAX_FILE_BYTES,
  type StoragePolicy,
  type StorageUsage,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

/** The storage allowance for a role, or null when the role is unlimited. */
export async function getStoragePolicy(role: UserRole): Promise<StoragePolicy | null> {
  const organizationId = await getDefaultOrganizationId();

  const [row] = await db
    .select()
    .from(schema.storagePolicy)
    .where(
      and(
        eq(schema.storagePolicy.organizationId, organizationId),
        eq(schema.storagePolicy.role, role),
        eq(schema.storagePolicy.enabled, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    role: row.role,
    maxTotalBytes: row.maxTotalBytes,
    maxFileCount: row.maxFileCount,
    maxFileBytes: row.maxFileBytes,
    enabled: row.enabled,
  };
}

export async function listStoragePolicies(): Promise<StoragePolicy[]> {
  const organizationId = await getDefaultOrganizationId();

  const rows = await db
    .select()
    .from(schema.storagePolicy)
    .where(eq(schema.storagePolicy.organizationId, organizationId))
    .orderBy(schema.storagePolicy.role);

  return rows.map((row) => ({
    role: row.role,
    maxTotalBytes: row.maxTotalBytes,
    maxFileCount: row.maxFileCount,
    maxFileBytes: row.maxFileBytes,
    enabled: row.enabled,
  }));
}

/**
 * A user's live counters. Soft-deleted bytes are reported separately and never
 * counted against the allowance: a user who clears space should get it back
 * immediately rather than waiting out the trash window.
 */
export async function getStorageUsage(userId: string, role: UserRole): Promise<StorageUsage> {
  const [row] = await db
    .select()
    .from(schema.storageUsage)
    .where(eq(schema.storageUsage.userId, userId))
    .limit(1);

  const policy = await getStoragePolicy(role);
  const storage = await getSetting('storage');

  return {
    liveBytes: Number(row?.liveBytes ?? 0),
    liveFileCount: row?.liveFileCount ?? 0,
    pendingBytes: Number(row?.pendingBytes ?? 0),
    pendingFileCount: row?.pendingFileCount ?? 0,
    maxTotalBytes: policy?.maxTotalBytes ?? null,
    maxFileCount: policy?.maxFileCount ?? null,
    // A role policy may tighten the per-file cap but never loosen it past the
    // instance setting, which also bounds the accepted request body.
    maxFileBytes: Math.min(
      policy?.maxFileBytes ?? Number.POSITIVE_INFINITY,
      storage.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    ),
  };
}

/**
 * Rejects an upload that would exceed the role's allowance. Checked before the
 * blob is written so a refused upload never consumes storage.
 */
export async function assertStorageAllowance(params: {
  userId: string;
  role: UserRole;
  incomingBytes: number;
  incomingFiles: number;
}): Promise<void> {
  const usage = await getStorageUsage(params.userId, params.role);

  if (usage.maxFileBytes !== null && params.incomingBytes > usage.maxFileBytes) {
    throw validationFailed(`Each file must be ${formatBytes(usage.maxFileBytes)} or smaller`);
  }

  if (
    usage.maxTotalBytes !== null &&
    usage.liveBytes + params.incomingBytes > usage.maxTotalBytes
  ) {
    const free = Math.max(0, usage.maxTotalBytes - usage.liveBytes);
    throw validationFailed(
      `This upload would exceed your ${formatBytes(usage.maxTotalBytes)} storage limit. ` +
        `You have ${formatBytes(free)} free; delete files in Settings to make room.`,
    );
  }

  if (
    usage.maxFileCount !== null &&
    usage.liveFileCount + params.incomingFiles > usage.maxFileCount
  ) {
    throw validationFailed(
      `This upload would exceed your limit of ${usage.maxFileCount.toLocaleString()} stored files. ` +
        'Delete files in Settings to make room.',
    );
  }
}

type Tx = Pick<typeof db, 'insert'>;

/**
 * Adjusts a user's counters. Called inside the same transaction as the
 * attachment write so the counter can never disagree with the rows it
 * summarizes, except through a crash, which reconciliation repairs.
 */
export async function adjustStorageUsage(
  tx: Tx,
  params: {
    organizationId: string;
    userId: string;
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
        // greatest() guards against a counter drifting below zero, which would
        // otherwise permanently understate a user's consumption.
        liveBytes: sql`greatest(0, ${schema.storageUsage.liveBytes} + ${liveBytes})`,
        liveFileCount: sql`greatest(0, ${schema.storageUsage.liveFileCount} + ${liveFiles})`,
        pendingBytes: sql`greatest(0, ${schema.storageUsage.pendingBytes} + ${pendingBytes})`,
        pendingFileCount: sql`greatest(0, ${schema.storageUsage.pendingFileCount} + ${pendingFiles})`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Rebuilds every counter from the attachment rows themselves. Counters are
 * maintained incrementally on the hot path, so this exists to repair drift
 * left by a crash between the blob write and the counter update.
 */
export async function recomputeStorageUsage(): Promise<number> {
  const totals = await db
    .select({
      organizationId: schema.attachment.organizationId,
      userId: schema.attachment.userId,
      liveBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is null), 0)::bigint`,
      liveFiles: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is null)::int`,
      pendingBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is not null), 0)::bigint`,
      pendingFiles: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is not null)::int`,
    })
    .from(schema.attachment)
    .groupBy(schema.attachment.organizationId, schema.attachment.userId);

  for (const row of totals) {
    await db
      .insert(schema.storageUsage)
      .values({
        organizationId: row.organizationId,
        userId: row.userId,
        liveBytes: Number(row.liveBytes),
        liveFileCount: Number(row.liveFiles),
        pendingBytes: Number(row.pendingBytes),
        pendingFileCount: Number(row.pendingFiles),
      })
      .onConflictDoUpdate({
        target: schema.storageUsage.userId,
        set: {
          liveBytes: Number(row.liveBytes),
          liveFileCount: Number(row.liveFiles),
          pendingBytes: Number(row.pendingBytes),
          pendingFileCount: Number(row.pendingFiles),
          updatedAt: new Date(),
        },
      });
  }

  // Users whose attachments are all gone need their counters zeroed too.
  const keptUserIds = totals.map((row) => row.userId);
  await db
    .update(schema.storageUsage)
    .set({ liveBytes: 0, liveFileCount: 0, pendingBytes: 0, pendingFileCount: 0 })
    .where(
      keptUserIds.length > 0
        ? sql`${schema.storageUsage.userId} <> all(${keptUserIds})`
        : sql`true`,
    );

  return totals.length;
}

/** Instance-wide totals for the admin overview. */
export async function storageTotals(): Promise<{
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
}> {
  const [row] = await db
    .select({
      liveBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is null), 0)::bigint`,
      liveFileCount: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is null)::int`,
      pendingBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is not null), 0)::bigint`,
      pendingFileCount: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is not null)::int`,
    })
    .from(schema.attachment);

  return {
    liveBytes: Number(row?.liveBytes ?? 0),
    liveFileCount: Number(row?.liveFileCount ?? 0),
    pendingBytes: Number(row?.pendingBytes ?? 0),
    pendingFileCount: Number(row?.pendingFileCount ?? 0),
  };
}
