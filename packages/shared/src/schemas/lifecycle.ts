import { z } from 'zod';
import {
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  QUOTA_METRICS,
  USER_ROLES,
} from '../constants.js';

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
  /**
   * User memory (v0.9): memories not updated for this many days are deleted
   * by the lifecycle job. Null (the default) keeps them until the person
   * deletes them.
   */
  memoryRetentionDays: z.number().int().min(1).max(3_650).nullable(),
  /** IANA zone for reporting only; limits reset on their own policy's zone. */
  displayTimezone: z.string().min(1).max(64),
});

export const updateRetentionSettingsSchema = retentionSettingsSchema.partial().strict();

export const rateLimitSettingsSchema = z.object({
  maxConcurrentStreams: z.number().int().min(1).max(100),
  chatRequestsPerMinute: z.number().int().min(1).max(10_000),
  uploadRequestsPerMinute: z.number().int().min(1).max(10_000),
});

/**
 * What a reservation holds before real usage is known. Lives with the rate
 * limits because the concurrency cap and this together bound how far
 * simultaneous runs can overshoot a budget.
 */
export const reserveAmountsSchema = z.object({
  costMicros: z.number().int().min(1).max(100_000_000),
  tokens: z.number().int().min(1).max(10_000_000),
});

export const updateRateLimitSettingsSchema = z
  .object({
    /** Keyed by role; a missing role keeps its current value. */
    // partialRecord: in Zod 4 a record keyed by an enum requires every key,
    // which would reject saving one role's limits.
    roles: z.partialRecord(z.enum(USER_ROLES), rateLimitSettingsSchema.partial()).optional(),
    authAttemptsPerMinute: z.number().int().min(1).max(1_000).optional(),
    reserve: reserveAmountsSchema.partial().optional(),
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

/**
 * Raises or lowers one policy's limit for one person. Only adjusts a limit the
 * user's role already carries; it never grants an unassigned policy.
 */
export const quotaOverrideSchema = z.object({
  policyId: z.string(),
  policyName: z.string(),
  metric: z.enum(QUOTA_METRICS),
  /** What the role would otherwise get, for comparison. */
  roleLimitValue: z.number().int().positive(),
  limitValue: z.number().int().positive(),
  expiresAt: z.string().nullable(),
  reason: z.string().nullable(),
  /** False once the expiry has passed; the row lingers until cleanup runs. */
  active: z.boolean(),
  createdAt: z.string(),
});

export const upsertQuotaOverrideSchema = z
  .object({
    policyId: z.string().min(1),
    limitValue: z.number().int().positive().max(1_000_000_000_000),
    /** Null never expires. Most overrides are temporary in practice. */
    expiresAt: z.string().datetime().nullable().optional(),
    reason: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

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
export type ReserveAmounts = z.infer<typeof reserveAmountsSchema>;
export type UpdateRateLimitSettings = z.infer<typeof updateRateLimitSettingsSchema>;
export type TrashedThread = z.infer<typeof trashedThreadSchema>;
export type JobRun = z.infer<typeof jobRunSchema>;
export type QuotaOverride = z.infer<typeof quotaOverrideSchema>;
export type UpsertQuotaOverrideInput = z.infer<typeof upsertQuotaOverrideSchema>;
