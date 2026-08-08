import { z } from 'zod';
import { MAX_TRASH_RETENTION_DAYS, MIN_TRASH_RETENTION_DAYS, USER_ROLES } from '../constants.js';

/**
 * Per-role storage allowance. Storage is a gauge rather than a flow, so these
 * carry no window: they ask how much a user holds right now.
 */
export const storagePolicySchema = z.object({
  role: z.enum(USER_ROLES),
  /** Null means unlimited for that dimension. */
  maxTotalBytes: z.number().int().positive().nullable(),
  maxFileCount: z.number().int().positive().nullable(),
  maxFileBytes: z.number().int().positive().nullable(),
  enabled: z.boolean(),
});

export const upsertStoragePolicySchema = z
  .object({
    role: z.enum(USER_ROLES),
    maxTotalBytes: z.number().int().positive().max(1_099_511_627_776).nullable().optional(),
    maxFileCount: z.number().int().positive().max(1_000_000).nullable().optional(),
    maxFileBytes: z.number().int().positive().max(1_073_741_824).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

/** A user's current consumption against their role's storage allowance. */
export const storageUsageSchema = z.object({
  liveBytes: z.number().int().nonnegative(),
  liveFileCount: z.number().int().nonnegative(),
  /** Soft-deleted but not yet purged. Excluded from the allowance. */
  pendingBytes: z.number().int().nonnegative(),
  pendingFileCount: z.number().int().nonnegative(),
  maxTotalBytes: z.number().int().positive().nullable(),
  maxFileCount: z.number().int().positive().nullable(),
  maxFileBytes: z.number().int().positive().nullable(),
});

export const retentionSettingsSchema = z.object({
  /** Grace period before soft-deleted content is destroyed. */
  trashRetentionDays: z.number().int().min(MIN_TRASH_RETENTION_DAYS).max(MAX_TRASH_RETENTION_DAYS),
  /** Null disables automatic conversation retention. */
  threadRetentionDays: z.number().int().min(1).max(3_650).nullable(),
  /** Pinned threads are exempt; the user marked them deliberately. */
  exemptPinnedThreads: z.boolean(),
  usageEventRetentionDays: z.number().int().min(1).max(3_650),
  auditLogRetentionDays: z.number().int().min(1).max(3_650),
});

export const updateRetentionSettingsSchema = retentionSettingsSchema.partial().strict();

export const rateLimitSettingsSchema = z.object({
  maxConcurrentStreams: z.number().int().min(1).max(100),
  chatRequestsPerMinute: z.number().int().min(1).max(10_000),
  uploadRequestsPerMinute: z.number().int().min(1).max(10_000),
});

export const updateRateLimitSettingsSchema = z
  .object({
    /** Keyed by role; a missing role keeps its current value. */
    roles: z.record(z.enum(USER_ROLES), rateLimitSettingsSchema.partial()).optional(),
    authAttemptsPerMinute: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

/** An item in the trash, restorable until its purge date. */
export const trashedThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  deletedAt: z.string(),
  deletedReason: z.enum(['user', 'retention', 'admin']).nullable(),
  purgeAt: z.string(),
});

export const jobRunSchema = z.object({
  id: z.string(),
  jobName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  itemsProcessed: z.number().int().nonnegative(),
  status: z.enum(['running', 'success', 'error']),
  errorMessage: z.string().nullable(),
});

export type StoragePolicy = z.infer<typeof storagePolicySchema>;
export type UpsertStoragePolicyInput = z.infer<typeof upsertStoragePolicySchema>;
export type StorageUsage = z.infer<typeof storageUsageSchema>;
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export type UpdateRetentionSettings = z.infer<typeof updateRetentionSettingsSchema>;
export type RateLimitSettings = z.infer<typeof rateLimitSettingsSchema>;
export type UpdateRateLimitSettings = z.infer<typeof updateRateLimitSettingsSchema>;
export type TrashedThread = z.infer<typeof trashedThreadSchema>;
export type JobRun = z.infer<typeof jobRunSchema>;
