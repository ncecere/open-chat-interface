import { z } from 'zod';
import {
  BACKUP_DESTINATIONS,
  backupPrefixSchema,
  backupS3TargetSchema,
  s3TargetPatchSchema,
} from './operations.js';

/**
 * Compliance export and legal hold (v0.9). See docs/admin/compliance.md.
 */

/** Key prefix used inside the attachment bucket; storage reconciliation skips it. */
export const COMPLIANCE_STORAGE_PREFIX = '.oci-compliance/';

export const COMPLIANCE_SCHEDULES = ['hourly', 'daily'] as const;
export type ComplianceSchedule = (typeof COMPLIANCE_SCHEDULES)[number];

/** Format identifier written into every manifest. */
export const COMPLIANCE_EXPORT_FORMAT = 'oci-compliance/1';

/** Compliance export settings as administrators see them. */
export const complianceSettingsSchema = z.object({
  enabled: z.boolean(),
  schedule: z.enum(COMPLIANCE_SCHEDULES),
  /** Hour of the day (UTC) a daily export starts; unused when hourly. */
  hourUtc: z.number().int().min(0).max(23),
  destination: z.enum(BACKUP_DESTINATIONS),
  /** Prefix within the separate bucket. The attachment bucket always uses `.oci-compliance/`. */
  prefix: z.string(),
  s3: backupS3TargetSchema,
  /** Conversation content as well as audit events. Off by default. */
  includeContent: z.boolean(),
  /** Days exported objects are kept; null keeps them (the default). */
  keepDays: z.number().int().nullable(),
});
export type ComplianceSettings = z.infer<typeof complianceSettingsSchema>;

/** Body of `PATCH /admin/compliance/settings`: only sent fields change. */
export const updateComplianceSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: z.enum(COMPLIANCE_SCHEDULES).optional(),
    hourUtc: z.number().int().min(0).max(23).optional(),
    destination: z.enum(BACKUP_DESTINATIONS).optional(),
    prefix: backupPrefixSchema.optional(),
    s3: s3TargetPatchSchema.optional(),
    includeContent: z.boolean().optional(),
    /** Null keeps exported objects; a number deletes them after that many days. */
    keepDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'Send at least one change.' });
export type UpdateComplianceSettingsInput = z.infer<typeof updateComplianceSettingsSchema>;

const streamSchema = z.object({
  key: z.string().nullable(),
  /** The cursor before the run; it holds sequence numbers above this one. */
  afterSeq: z.number().nullable(),
  /** Up to and including this one. */
  throughSeq: z.number().nullable(),
  count: z.number().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
});

export const complianceRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  destination: z.enum(BACKUP_DESTINATIONS),
  includeContent: z.boolean(),
  audit: streamSchema,
  /** Null when the run did not include conversation content. */
  messages: streamSchema.nullable(),
  manifestKey: z.string().nullable(),
  verified: z.boolean(),
  errorMessage: z.string().nullable(),
  prunedAt: z.string().nullable(),
});
export type ComplianceRun = z.infer<typeof complianceRunSchema>;

/** A legal hold, active or lifted. */
export const legalHoldSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** The account's current address, or the one recorded when the hold was placed. */
  userEmail: z.string(),
  userName: z.string().nullable(),
  reason: z.string(),
  placedAt: z.string(),
  placedByEmail: z.string().nullable(),
  liftedAt: z.string().nullable(),
  liftedByEmail: z.string().nullable(),
  liftReason: z.string().nullable(),
});
export type LegalHold = z.infer<typeof legalHoldSchema>;

/** Body of `POST /admin/compliance/holds`: a person by id or email, and why. */
export const placeLegalHoldSchema = z
  .object({
    userId: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().max(320).optional(),
    reason: z
      .string()
      .trim()
      .min(1, 'Give a reason, such as a matter or case reference.')
      .max(1000),
  })
  .strict()
  .refine((input) => Boolean(input.userId || input.email), {
    path: ['email'],
    message: 'Name the person to hold.',
  });
export type PlaceLegalHoldInput = z.infer<typeof placeLegalHoldSchema>;

/** Body of `POST /admin/compliance/holds/:id/lift`. */
export const liftLegalHoldSchema = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();
export type LiftLegalHoldInput = z.infer<typeof liftLegalHoldSchema>;

/** `GET /admin/compliance`. */
export const complianceStatusSchema = z.object({
  settings: complianceSettingsSchema,
  /** Why an export cannot run with these settings; empty when it can. */
  issues: z.array(z.string()),
  attachmentStorage: z.object({ driver: z.enum(['local', 's3']), bucket: z.string().nullable() }),
  running: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  /** The last exported sequence number of each stream (0 before the first export). */
  cursor: z.object({ audit: z.number(), messages: z.number().nullable() }),
  runs: z.array(complianceRunSchema),
  holds: z.array(legalHoldSchema),
});
export type ComplianceStatus = z.infer<typeof complianceStatusSchema>;
