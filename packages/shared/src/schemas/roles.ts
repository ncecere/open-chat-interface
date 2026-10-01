import { z } from 'zod';
import { QUOTA_METRICS, QUOTA_WINDOW_KINDS, USER_ROLES } from '../constants.js';
import { rateLimitSettingsSchema, storagePolicySchema } from './lifecycle.js';

export const CONFIG_SOURCES = ['database', 'environment', 'default'] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

const configSourceSchema = z.enum(CONFIG_SOURCES);

/**
 * Everything that shapes what one role may do, gathered from the five places
 * it is configured. Read-only: each part is still changed through its own
 * endpoint, so this cannot drift from the enforcement code.
 */
export const roleAccessSchema = z.object({
  role: z.enum(USER_ROLES),
  userCount: z.number().int().nonnegative(),
  rateLimits: rateLimitSettingsSchema,
  rateLimitSources: z.object({
    maxConcurrentStreams: configSourceSchema,
    chatRequestsPerMinute: configSourceSchema,
    uploadRequestsPerMinute: configSourceSchema,
  }),
  /** Null when the role has no storage policy, which means unlimited. */
  storage: storagePolicySchema.nullable(),
  budgets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      metric: z.enum(QUOTA_METRICS),
      limitValue: z.number().int().positive(),
      windowKind: z.enum(QUOTA_WINDOW_KINDS),
      windowHours: z.number().int().positive().nullable(),
      enabled: z.boolean(),
    }),
  ),
  models: z.object({
    /** Enabled models on enabled providers that this role can see. */
    visible: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  }),
  /** Instance features as they apply to this role after role restrictions. */
  features: z.object({
    attachments: z.boolean(),
    shareLinks: z.boolean(),
    temporaryChat: z.boolean(),
    webSearch: z.boolean(),
  }),
  /** Fixed rules for the role that no setting changes. */
  fixedRules: z.array(z.string()),
});

export const rolesAccessSchema = z.object({ roles: z.array(roleAccessSchema) });

export type RoleAccess = z.infer<typeof roleAccessSchema>;
export type RolesAccess = z.infer<typeof rolesAccessSchema>;
