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

import { artifactBytes, artifactCount, projectFileTotals } from './usage.js';

export { adjustStorageUsage, recomputeStorageUsage } from './usage.js';

export function formatBytes(bytes: number): string {
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
  return row
    ? {
        role: row.role,
        maxTotalBytes: row.maxTotalBytes,
        maxFileCount: row.maxFileCount,
        maxFileBytes: row.maxFileBytes,
        enabled: row.enabled,
      }
    : null;
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

/** Resolve settings before entering any database transaction. */
export async function getStorageLimits(role: UserRole) {
  const policy = await getStoragePolicy(role);
  const storage = await getSetting('storage');
  return {
    maxTotalBytes: policy?.maxTotalBytes ?? null,
    maxFileCount: policy?.maxFileCount ?? null,
    maxFileBytes: Math.min(
      policy?.maxFileBytes ?? Number.POSITIVE_INFINITY,
      storage.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    ),
  };
}

/**
 * Live usage includes upload reservations and artifact versions; trashed
 * files and the artifacts of trashed conversations do not consume allowance.
 *
 * The breakdown (v0.9.1) splits the same total three ways. Chat files are
 * the counted file total less project files, so the three always add up to
 * `liveBytes` even if a counter and the rows briefly disagree.
 */
export async function getStorageUsage(userId: string, role: UserRole): Promise<StorageUsage> {
  const [[row], artifacts, artifactsCount, project] = await Promise.all([
    db.select().from(schema.storageUsage).where(eq(schema.storageUsage.userId, userId)).limit(1),
    artifactBytes(db, userId),
    artifactCount(db, userId),
    projectFileTotals(db, userId),
  ]);
  const fileBytes = Number(row?.liveBytes ?? 0);
  const fileCount = row?.liveFileCount ?? 0;
  const projectBytes = Math.min(project.bytes, fileBytes);
  const projectCount = Math.min(project.count, fileCount);
  return {
    liveBytes: fileBytes + artifacts,
    artifactBytes: artifacts,
    breakdown: {
      chatFiles: { bytes: fileBytes - projectBytes, count: fileCount - projectCount },
      projectFiles: { bytes: projectBytes, count: projectCount },
      artifacts: { bytes: artifacts, count: artifactsCount },
    },
    liveFileCount: fileCount,
    pendingBytes: Number(row?.pendingBytes ?? 0),
    pendingFileCount: row?.pendingFileCount ?? 0,
    ...(await getStorageLimits(role)),
  };
}

type Incoming = { incomingBytes: number; incomingFiles: number; checkFileSize?: boolean };
type Allowance = Pick<
  StorageUsage,
  'liveBytes' | 'liveFileCount' | 'maxFileBytes' | 'maxFileCount' | 'maxTotalBytes'
>;

/** Admission callers must supply authoritative totals while holding the usage row lock. */
export function assertStorageAllowanceForUsage(usage: Allowance, params: Incoming): void {
  if (
    params.checkFileSize !== false &&
    usage.maxFileBytes !== null &&
    params.incomingBytes > usage.maxFileBytes
  ) {
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

/** Advisory only; never use a detached check as upload admission. */
export async function assertStorageAllowance(
  params: Incoming & { userId: string; role: UserRole },
): Promise<void> {
  assertStorageAllowanceForUsage(await getStorageUsage(params.userId, params.role), params);
}

/** Instance-wide totals, including unfinished upload reservations and artifact versions. */
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
  const [artifacts] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${schema.artifactVersion.sizeBytes}), 0)::bigint`,
    })
    .from(schema.artifactVersion);
  return {
    liveBytes: Number(row?.liveBytes ?? 0) + Number(artifacts?.bytes ?? 0),
    liveFileCount: Number(row?.liveFileCount ?? 0),
    pendingBytes: Number(row?.pendingBytes ?? 0),
    pendingFileCount: Number(row?.pendingFileCount ?? 0),
  };
}
