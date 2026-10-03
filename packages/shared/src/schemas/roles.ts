import { z } from 'zod';
import { QUOTA_METRICS, QUOTA_WINDOW_KINDS, REASONING_EFFORTS, USER_ROLES } from '../constants.js';
import { roleToolSchema } from '../tools.js';
import { rateLimitSettingsSchema, storagePolicySchema } from './lifecycle.js';

export const CONFIG_SOURCES = ['database', 'environment', 'default'] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

const configSourceSchema = z.enum(CONFIG_SOURCES);

/** A role's own feature switches and reasoning levels, before instance switches. */
export const roleFeaturesSchema = z.object({
  webSearch: z.boolean(),
  attachments: z.boolean(),
  shareLinks: z.boolean(),
  temporaryChat: z.boolean(),
  branching: z.boolean(),
  projects: z.boolean(),
  memory: z.boolean(),
  /** Absent in settings saved before v0.9; the default applies. */
  artifacts: z.boolean(),
  /** People may delete their own account (v0.10); off by default for every role. */
  accountDeletion: z.boolean(),
  reasoningEfforts: z.array(z.enum(REASONING_EFFORTS)),
});

/**
 * Body of `PUT /admin/roles/:role`. Every field is optional and has no default,
 * so a request changes only what it sends. Instant is always allowed, so a
 * list of reasoning levels must include it.
 */
export const updateRoleFeaturesSchema = z
  .object({
    webSearch: z.boolean().optional(),
    attachments: z.boolean().optional(),
    shareLinks: z.boolean().optional(),
    temporaryChat: z.boolean().optional(),
    branching: z.boolean().optional(),
    projects: z.boolean().optional(),
    memory: z.boolean().optional(),
    artifacts: z.boolean().optional(),
    accountDeletion: z.boolean().optional(),
    reasoningEfforts: z
      .array(z.enum(REASONING_EFFORTS))
      .max(REASONING_EFFORTS.length)
      .refine((efforts) => new Set(efforts).size === efforts.length, {
        message: 'Each reasoning level may be listed once.',
      })
      .refine((efforts) => efforts.includes('instant'), {
        message: 'Instant is always allowed.',
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one change.' });

/**
 * Everything that shapes what one role may do, gathered from the places it is
 * configured. Each part is changed through its own endpoint; the role's
 * feature switches through `PUT /admin/roles/:role`.
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
  /**
   * Features as someone in this role experiences them: the role allows it and
   * the instance-wide switch is on (web search also needs a working provider).
   */
  features: z.object({
    attachments: z.boolean(),
    shareLinks: z.boolean(),
    temporaryChat: z.boolean(),
    webSearch: z.boolean(),
    branching: z.boolean(),
    projects: z.boolean(),
    /** Instance switch and role; each person still opts in themselves. */
    memory: z.boolean(),
    artifacts: z.boolean(),
    /** Decided by the role alone; there is no instance-wide switch. */
    accountDeletion: z.boolean(),
  }),
  /** The role's own, editable switches and reasoning levels. */
  roleFeatures: roleFeaturesSchema,
  /**
   * Every registered tool and whether this role may use it. Changed through
   * `PUT /admin/roles/:role/tools`.
   */
  tools: z.array(roleToolSchema),
  /** Fixed rules for the role that no setting changes. */
  fixedRules: z.array(z.string()),
});

export const rolesAccessSchema = z.object({ roles: z.array(roleAccessSchema) });

export type RoleAccess = z.infer<typeof roleAccessSchema>;
export type RolesAccess = z.infer<typeof rolesAccessSchema>;
export type UpdateRoleFeaturesInput = z.infer<typeof updateRoleFeaturesSchema>;
