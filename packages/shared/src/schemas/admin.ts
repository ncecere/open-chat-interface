import { z } from 'zod';
import { HEX_COLOR_PATTERN, isSafeImageUrl } from '../branding.js';
import {
  COLOR_THEMES,
  QUOTA_METRICS,
  QUOTA_WINDOW_KINDS,
  REASONING_EFFORTS,
  REGISTRATION_MODES,
  SEARCH_PROVIDER_KINDS,
  STORAGE_DRIVERS,
  THEME_MODES,
  USER_ROLES,
} from '../constants.js';
import { DEFAULT_MAX_TOOL_STEPS, MAX_TOOL_STEPS, MIN_TOOL_STEPS } from '../tools.js';
import { patchSchema } from './patch.js';

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
  /** On legal hold (v0.9): retention and deletion skip this person's data. */
  legalHold: z.boolean().optional(),
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
  /** Compact mark for the sidebar. Falls back to initials of the full name. */
  shortName: z.string().nullable(),
  logoUrl: z.string().nullable(),
  accentColor: z.string().nullable(),
  loginMessage: z.string().nullable(),
  defaultTheme: z.enum(THEME_MODES),
  colorTheme: z.enum(COLOR_THEMES),
  registrationMode: z.enum(REGISTRATION_MODES),
  emailVerificationRequired: z.boolean(),
  localAuthEnabled: z.boolean(),
  /** Days a session stays valid, and how often activity extends it. */
  sessionLifetimeDays: z.number().int().min(1).max(365).default(30),
  sessionRefreshDays: z.number().int().min(1).max(365).default(1),
  defaultSystemPrompt: z.string().nullable(),
  /**
   * Reasoning level a new conversation starts at. Clients lower it to what the
   * selected model and the person's role allow, falling back to instant.
   */
  defaultEffort: z.enum(REASONING_EFFORTS).default('instant'),
  /** Model steps one reply may take when it uses tools; reaching it ends the reply with a note. */
  maxToolSteps: z
    .number()
    .int()
    .min(MIN_TOOL_STEPS)
    .max(MAX_TOOL_STEPS)
    .default(DEFAULT_MAX_TOOL_STEPS),
  /**
   * Summarise a conversation's earlier turns in the background when it nears
   * the model's input limit, instead of dropping them. People can still ask
   * for a summary themselves when off.
   */
  autoCompact: z.boolean().default(true),
  /**
   * When artifacts are available, ask models to draw diagrams as SVG artifacts
   * following the Diagram Design style guide (MIT, Cathryn Lavery), mapped to
   * the instance's accent colour.
   */
  diagramGuidance: z.boolean().default(true),
  features: z.object({
    shareLinks: z.boolean(),
    temporaryChat: z.boolean(),
    webSearch: z.boolean(),
    attachments: z.boolean(),
    branching: z.boolean(),
    /**
     * User memory (v0.9), off by default. Each role and each person must also
     * allow it. Absent from settings saved before v0.9 (and from an older
     * API's response), which read as off.
     */
    memory: z.boolean().default(false),
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
    /**
     * A second provider (v0.10), used only when the first times out or fails
     * with a server or network error, after its one retry. Null when unset;
     * absent from an older API's response, which reads as none. Its
     * credential is write-only like the primary's.
     */
    fallbackProvider: z.enum(SEARCH_PROVIDER_KINDS).nullable().optional(),
    fallbackBaseUrl: z.string().nullable().optional(),
    hasFallbackCredential: z.boolean().optional(),
  }),
  smtp: z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
    port: z.number().int().positive().nullable(),
    secure: z.boolean(),
    fromAddress: z.string().nullable(),
    /** Whether a username and a password are stored; never their values. */
    hasUsername: z.boolean().optional(),
    hasPassword: z.boolean().optional(),
  }),
});

/** `help@acme.test`, or `Help Desk <help@acme.test>` (apps/api/src/services/email.ts). */
const FROM_ADDRESS = /^(?:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|[^<>]+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)$/;

// Defaults belong to reads of older stored settings, never to a partial write.
export const updateInstanceSettingsSchema = patchSchema(instanceSettingsSchema)
  .omit({ smtp: true, search: true, storage: true, features: true })
  .extend({
    // Shown on the public sign-in page, so only an image address is stored.
    logoUrl: z
      .string()
      .trim()
      .max(2_048)
      .refine(isSafeImageUrl, 'Use an http(s) URL or a root-relative path beginning with /.')
      .nullable()
      .optional(),
    // API-only diagram accent override (not on the Branding page, which
    // offers colour themes); diagrams follow the colour theme while it is null.
    accentColor: z
      .string()
      .trim()
      .regex(HEX_COLOR_PATTERN, 'Use a hex colour such as #3366ff.')
      .nullable()
      .optional(),
    // `memory` arrived in v0.9: a client that does not know it must not
    // switch it off by leaving it out of the (otherwise whole) object.
    features: instanceSettingsSchema.shape.features
      .extend({ memory: z.boolean().optional() })
      .optional(),
    storage: instanceSettingsSchema.shape.storage
      // localPath is reported for reference only; it is fixed by the
      // deployment and must not be writable through the admin API.
      .omit({ s3: true, localPath: true })
      .partial()
      .extend({ s3: updateS3SettingsSchema.optional() })
      .optional(),
    search: instanceSettingsSchema.shape.search
      .omit({ hasFallbackCredential: true })
      .partial()
      .extend({
        apiKey: z.string().max(500).nullable().optional(),
        fallbackBaseUrl: z.string().max(2000).nullable().optional(),
        fallbackApiKey: z.string().max(500).nullable().optional(),
      })
      .optional(),
    smtp: instanceSettingsSchema.shape.smtp
      .partial()
      .extend({
        port: z.number().int().min(1).max(65_535).nullable().optional(),
        fromAddress: z
          .string()
          .trim()
          .max(320)
          .regex(
            FROM_ADDRESS,
            'Use an email address, optionally with a name: Help Desk <help@example.edu>.',
          )
          .nullable()
          .optional(),
        username: z.string().max(200).nullable().optional(),
        password: z.string().max(500).nullable().optional(),
      })
      .optional(),
  })
  // An unknown key is a mistake (a typo, or a client newer than this API),
  // not something to answer "ok" to while ignoring it.
  .strict();

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
  threads: z.object({
    total: z.number(),
    last24h: z.number(),
    /** The 24 hours before that, so the figure above can be compared. */
    previous24h: z.number(),
  }),
  messages: z.object({ total: z.number(), last24h: z.number(), previous24h: z.number() }),
  /** Daily message counts, oldest first, for a shape rather than a number. */
  activity: z.array(z.object({ day: z.string(), messages: z.number() })),
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

/** One provider to test: its kind, and the address or key typed on the page. */
const searchTestTargetSchema = z.object({
  provider: z.enum(SEARCH_PROVIDER_KINDS),
  baseUrl: z.string().max(2000).nullable().optional(),
  apiKey: z.string().max(500).optional(),
});

/**
 * A trial search from the Web search page, before or after saving. Without a
 * key, the saved key is used when it belongs to the same provider. With
 * `fallback` (v0.10), the fallback provider is tested too, on its own: the
 * saved fallback key is used when it belongs to that provider.
 */
export const searchTestSchema = searchTestTargetSchema.extend({
  fallback: searchTestTargetSchema.optional(),
});
export type SearchTestInput = z.infer<typeof searchTestSchema>;

export interface SearchTestResult {
  ok: boolean;
  /** Results returned for the sample query, when it worked. */
  results?: number;
  /** What went wrong, in words for an administrator. */
  message?: string;
  /** The fallback provider's own test, when one was asked for. */
  fallback?: Omit<SearchTestResult, 'fallback'>;
}

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
