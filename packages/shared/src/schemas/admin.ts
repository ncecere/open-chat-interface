import { z } from 'zod';
import {
  COLOR_THEMES,
  QUOTA_METRICS,
  QUOTA_WINDOW_KINDS,
  REGISTRATION_MODES,
  SEARCH_PROVIDER_KINDS,
  STORAGE_DRIVERS,
  THEME_MODES,
  USER_ROLES,
} from '../constants.js';

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  role: z.enum(USER_ROLES),
  emailVerified: z.boolean(),
  banned: z.boolean(),
  banReason: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  threadCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(USER_ROLES).default('user'),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  banned: z.boolean().optional(),
  banReason: z.string().trim().max(500).nullable().optional(),
});

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  role: z.enum(USER_ROLES),
  token: z.string(),
  expiresAt: z.string().nullable(),
  redeemedAt: z.string().nullable(),
  redeemedByUserId: z.string().nullable(),
  createdAt: z.string(),
});

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  role: z.enum(USER_ROLES).default('user'),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

const s3EndpointSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Endpoint must use HTTP or HTTPS',
  })
  .refine((value) => !/^https?:\/\/[^/]*@/i.test(value), {
    message: 'Endpoint must not include credentials',
  });

const s3SettingsSchema = z.object({
  bucket: z.string().trim().max(255),
  region: z.string().trim().max(100),
  endpoint: s3EndpointSchema.nullable(),
  accessKeyId: z.string().trim().max(255),
  forcePathStyle: z.boolean(),
  hasCredential: z.boolean(),
});

const updateS3SettingsSchema = s3SettingsSchema
  .omit({ hasCredential: true })
  .partial()
  .extend({
    /** Omit or send an empty string to keep, send a value to replace, or null to clear. */
    secretAccessKey: z.string().max(2_048).nullable().optional(),
  })
  .strict();

export const instanceSettingsSchema = z.object({
  appName: z.string(),
  logoUrl: z.string().nullable(),
  accentColor: z.string().nullable(),
  loginMessage: z.string().nullable(),
  defaultTheme: z.enum(THEME_MODES),
  colorTheme: z.enum(COLOR_THEMES),
  registrationMode: z.enum(REGISTRATION_MODES),
  emailVerificationRequired: z.boolean(),
  localAuthEnabled: z.boolean(),
  defaultSystemPrompt: z.string().nullable(),
  features: z.object({
    shareLinks: z.boolean(),
    temporaryChat: z.boolean(),
    canvas: z.boolean(),
    mcp: z.boolean(),
    webSearch: z.boolean(),
    attachments: z.boolean(),
    branching: z.boolean(),
  }),
  storage: z.object({
    driver: z.enum(STORAGE_DRIVERS),
    /** Read-only; the path must exist in the container, so it is env-managed. */
    localPath: z.string(),
    maxFileBytes: z.number().int().positive(),
    maxFilesPerMessage: z.number().int().positive(),
    allowedMimeTypes: z.array(z.string()),
    s3: s3SettingsSchema,
  }),
  search: z.object({
    enabled: z.boolean(),
    provider: z.enum(SEARCH_PROVIDER_KINDS).nullable(),
    baseUrl: z.string().nullable(),
    hasCredential: z.boolean(),
    maxResults: z.number().int().positive(),
  }),
  smtp: z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
    port: z.number().int().positive().nullable(),
    secure: z.boolean(),
    fromAddress: z.string().nullable(),
  }),
});

export const updateInstanceSettingsSchema = instanceSettingsSchema
  .partial()
  .omit({ smtp: true, search: true, storage: true })
  .extend({
    storage: instanceSettingsSchema.shape.storage
      // localPath is reported for reference only; it is fixed by the
      // deployment and must not be writable through the admin API.
      .omit({ s3: true, localPath: true })
      .partial()
      .extend({ s3: updateS3SettingsSchema.optional() })
      .optional(),
    search: instanceSettingsSchema.shape.search
      .partial()
      .extend({ apiKey: z.string().max(500).nullable().optional() })
      .optional(),
    smtp: instanceSettingsSchema.shape.smtp
      .partial()
      .extend({
        username: z.string().max(200).nullable().optional(),
        password: z.string().max(500).nullable().optional(),
      })
      .optional(),
  });

/**
 * A named limit an admin can apply to any number of roles. `limitValue` is
 * expressed in the metric's own unit: messages, tokens, or micro-dollars.
 */
export const quotaPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  metric: z.enum(QUOTA_METRICS),
  limitValue: z.number().int().positive(),
  windowKind: z.enum(QUOTA_WINDOW_KINDS),
  windowHours: z.number().int().positive().nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  roles: z.array(z.enum(USER_ROLES)),
  /** Empty means the policy applies to every model. */
  modelSlugs: z.array(z.string()),
  /** How many people hold a per-user override of this policy's limit. */
  overrideCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const upsertQuotaPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    metric: z.enum(QUOTA_METRICS),
    limitValue: z.number().int().positive().max(1_000_000_000_000),
    windowKind: z.enum(QUOTA_WINDOW_KINDS),
    /** Required for rolling windows and ignored by calendar windows. */
    windowHours: z.number().int().positive().max(8_760).nullable().optional(),
    /** IANA zone; only meaningful for calendar windows. */
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    enabled: z.boolean().default(true),
    roles: z.array(z.enum(USER_ROLES)).max(USER_ROLES.length).default([]),
    /** Empty applies the policy to every model; models are chosen explicitly. */
    modelSlugs: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.windowKind === 'rolling' && !value.windowHours) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowHours'],
        message: 'Rolling windows require a length in hours.',
      });
    }
  });

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
});

/** One policy's consumption, as shown in the user-facing usage meter. */
export const usageAllowanceSchema = z.object({
  policyId: z.string(),
  name: z.string(),
  metric: z.enum(QUOTA_METRICS),
  windowKind: z.enum(QUOTA_WINDOW_KINDS),
  windowHours: z.number().int().positive().nullable(),
  used: z.number().int().nonnegative(),
  limitValue: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
  exceeded: z.boolean(),
  resetsAt: z.string().nullable(),
  /** Empty means the policy covers every model. */
  modelSlugs: z.array(z.string()),
  /** Drives the in-app warning before a user is cut off. */
  severity: z.enum(['ok', 'warning', 'critical', 'exceeded']),
});

export const usageSummarySchema = z.object({
  allowances: z.array(usageAllowanceSchema),
  /** Raw consumption over the trailing 24 hours, shown when no policy applies. */
  recent: z.object({
    messages: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  }),
});

export const adminOverviewSchema = z.object({
  users: z.object({ total: z.number(), active30d: z.number(), admins: z.number() }),
  threads: z.object({ total: z.number(), last24h: z.number() }),
  messages: z.object({ total: z.number(), last24h: z.number() }),
  models: z.object({ enabled: z.number(), total: z.number() }),
  providers: z.object({ configured: z.number(), enabled: z.number() }),
  storage: z.object({
    fileCount: z.number(),
    totalBytes: z.number(),
    /** Soft-deleted but still occupying disk until the trash window elapses. */
    pendingFileCount: z.number(),
    pendingBytes: z.number(),
  }),
  system: z.object({
    version: z.string(),
    database: z.enum(['ok', 'error']),
    redis: z.enum(['ok', 'error', 'disabled']),
  }),
});

export type AdminUser = z.infer<typeof adminUserSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
export type UpdateInstanceSettings = z.infer<typeof updateInstanceSettingsSchema>;
export type QuotaPolicy = z.infer<typeof quotaPolicySchema>;
export type UpsertQuotaPolicyInput = z.infer<typeof upsertQuotaPolicySchema>;
export type UsageAllowance = z.infer<typeof usageAllowanceSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
