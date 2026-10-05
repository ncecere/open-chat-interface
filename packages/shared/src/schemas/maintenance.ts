import { z } from 'zod';

/**
 * Read-only maintenance mode (v0.11 design, section 9; docs/admin/maintenance.md).
 *
 * While it is on, people can read, search, export and sign in and out; every
 * other change is refused with `423 Locked` and the error code `READ_ONLY`
 * before the server does any work, with `Retry-After` when the end is known.
 */

/** Why the instance is read-only: the environment wins and cannot be undone from the UI. */
export const READ_ONLY_SOURCES = ['environment', 'administrator', 'schedule'] as const;
export type ReadOnlySource = (typeof READ_ONLY_SOURCES)[number];

/** The HTTP status of a write refused while read-only (not 503: that takes a replica out of rotation). */
export const READ_ONLY_STATUS = 423;

/**
 * Background jobs that keep running while read-only unless the administrator
 * chooses otherwise: backups and compliance exports (what an operator wants
 * before a risky change), webhook deliveries (the audit trail of the switch
 * itself reaches the SIEM) and the recovery of replies cut short (replies in
 * progress finish; one whose replica died is saved as interrupted).
 */
export const DEFAULT_READ_ONLY_KEEP_RUNNING_JOBS = [
  'backups.run',
  'compliance.export',
  'webhooks.deliver',
  'chat.recover-interrupted-replies',
] as const;

export const MAX_READ_ONLY_REASON_LENGTH = 500;

/** What everyone (signed in or not) may read: whether writes are refused now, and why. */
export const readOnlyStatusSchema = z.object({
  active: z.boolean(),
  source: z.enum(READ_ONLY_SOURCES).nullable(),
  reason: z.string().nullable(),
  /** When it is expected to end (ISO), when known. */
  until: z.string().nullable(),
  /** The next or current scheduled window, if any. */
  window: z.object({ startsAt: z.string(), endsAt: z.string() }).nullable(),
});
export type ReadOnlyStatus = z.infer<typeof readOnlyStatusSchema>;

export const INACTIVE_READ_ONLY_STATUS: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};

/** One background job and whether it keeps running while read-only. */
export const readOnlyJobSchema = z.object({
  name: z.string(),
  keepsRunning: z.boolean(),
  /** Whether it keeps running by default. */
  defaultKeepsRunning: z.boolean(),
});

/** The administrator's view (System health, Maintenance). */
export const maintenanceSettingsSchema = z.object({
  status: readOnlyStatusSchema,
  /** OCI_READ_ONLY=true: on regardless of the settings below, and cannot be turned off here. */
  environmentLocked: z.boolean(),
  /** The administrator's switch (independent of a window and the environment). */
  readOnly: z.boolean(),
  reason: z.string().nullable(),
  until: z.string().nullable(),
  changedAt: z.string().nullable(),
  changedBy: z.string().nullable(),
  window: z
    .object({
      startsAt: z.string(),
      endsAt: z.string(),
      reason: z.string().nullable(),
      announcementId: z.string().nullable(),
    })
    .nullable(),
  jobs: z.array(readOnlyJobSchema),
});
export type MaintenanceSettings = z.infer<typeof maintenanceSettingsSchema>;

const isoTime = z.string().datetime({ offset: true });

/** Body of `PUT /api/admin/maintenance`: only sent fields change. */
export const updateMaintenanceSchema = z
  .object({
    readOnly: z.boolean().optional(),
    reason: z.string().trim().max(MAX_READ_ONLY_REASON_LENGTH).nullable().optional(),
    until: isoTime.nullable().optional(),
    /** Null cancels the window (and its announcement). */
    window: z
      .object({
        startsAt: isoTime,
        endsAt: isoTime,
        reason: z.string().trim().max(MAX_READ_ONLY_REASON_LENGTH).nullable().optional(),
        /** Publish an announcement from now until the window starts. */
        announce: z.boolean().default(true),
      })
      .strict()
      .nullable()
      .optional(),
    keepRunningJobs: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0)
      ctx.addIssue({ code: 'custom', message: 'Send at least one change.' });
    if (value.window && Date.parse(value.window.endsAt) <= Date.parse(value.window.startsAt))
      ctx.addIssue({
        code: 'custom',
        path: ['window', 'endsAt'],
        message: 'The end must be after the start.',
      });
    if (value.window && Date.parse(value.window.endsAt) <= Date.now())
      ctx.addIssue({
        code: 'custom',
        path: ['window', 'endsAt'],
        message: 'The window has already ended.',
      });
  });
export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;
