import { z } from 'zod';
import {
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

export const instanceSettingsSchema = z.object({
  appName: z.string(),
  logoUrl: z.string().nullable(),
  accentColor: z.string().nullable(),
  loginMessage: z.string().nullable(),
  defaultTheme: z.enum(THEME_MODES),
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
    personas: z.boolean(),
    branching: z.boolean(),
  }),
  storage: z.object({
    driver: z.enum(STORAGE_DRIVERS),
    maxFileBytes: z.number().int().positive(),
    maxFilesPerMessage: z.number().int().positive(),
    allowedMimeTypes: z.array(z.string()),
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
    storage: instanceSettingsSchema.shape.storage.partial().optional(),
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

export const roleQuotaSchema = z.object({
  role: z.enum(USER_ROLES),
  enabled: z.boolean(),
  maxMessagesPerWindow: z.number().int().positive().nullable(),
  maxTokensPerWindow: z.number().int().positive().nullable(),
  windowHours: z.number().int().positive(),
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

export const adminOverviewSchema = z.object({
  users: z.object({ total: z.number(), active30d: z.number(), admins: z.number() }),
  threads: z.object({ total: z.number(), last24h: z.number() }),
  messages: z.object({ total: z.number(), last24h: z.number() }),
  models: z.object({ enabled: z.number(), total: z.number() }),
  providers: z.object({ configured: z.number(), enabled: z.number() }),
  storage: z.object({ fileCount: z.number(), totalBytes: z.number() }),
  system: z.object({
    version: z.string(),
    database: z.enum(['ok', 'error']),
    redis: z.enum(['ok', 'error', 'disabled']),
  }),
});

export type AdminUser = z.infer<typeof adminUserSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
export type RoleQuota = z.infer<typeof roleQuotaSchema>;
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
