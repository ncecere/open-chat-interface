import { z } from 'zod';
import { patchSchema } from './patch.js';

/**
 * Automated backups and webhooks (v0.9). See docs/admin/backups.md and
 * docs/admin/observability.md.
 */

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * `storage`: the attachment S3 bucket, under the reserved `.oci-backups/`
 * prefix. `separate`: its own bucket and credentials (recommended).
 */
export const BACKUP_DESTINATIONS = ['storage', 'separate'] as const;
export type BackupDestination = (typeof BACKUP_DESTINATIONS)[number];

/** Key prefix used inside the attachment bucket; storage reconciliation skips it. */
export const BACKUP_STORAGE_PREFIX = '.oci-backups/';

export const DEFAULT_BACKUP_KEEP_DAILY = 7;
export const DEFAULT_BACKUP_KEEP_WEEKLY = 4;

/**
 * How many copied attachment files each backup reads back from the
 * destination and checksums: a random `sample`, or `all` of them.
 */
export const BACKUP_FILE_VERIFICATION = ['sample', 'all'] as const;
export type BackupFileVerification = (typeof BACKUP_FILE_VERIFICATION)[number];
/** Files read back per run with `sample` verification. */
export const BACKUP_FILE_SAMPLE_SIZE = 32;

const backupEndpointSchema = z
  .string()
  .trim()
  .max(2_048)
  .url('Enter the endpoint’s full URL, such as https://s3.example.com.')
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Endpoint must use HTTP or HTTPS' })
  .refine((value) => !/^https?:\/\/[^/]*@/i.test(value), {
    message: 'Endpoint must not include credentials',
  });

/** Relative object-key prefix: no leading slash, no `..`, ends with `/`. */
export const backupPrefixSchema = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^([A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/,
    'Use folder names of letters, digits, dots, hyphens and underscores, each followed by /, such as oci-backups/.',
  )
  .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'), {
    message: 'The prefix cannot contain . or .. folders.',
  });

export const backupS3TargetSchema = z.object({
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string().nullable(),
  accessKeyId: z.string(),
  forcePathStyle: z.boolean(),
  hasCredential: z.boolean(),
});

/** Backup settings as administrators see them. The secret is reported as set or not set. */
export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Hour of the day (UTC) the scheduled backup starts. */
  hourUtc: z.number().int().min(0).max(23),
  destination: z.enum(BACKUP_DESTINATIONS),
  /** Prefix within the separate bucket. The attachment bucket always uses `.oci-backups/`. */
  prefix: z.string(),
  s3: backupS3TargetSchema,
  keepDaily: z.number().int(),
  keepWeekly: z.number().int(),
  /** Copy attachment files to the destination (content addressed, incremental). */
  copyFiles: z.boolean(),
  verifyFiles: z.enum(BACKUP_FILE_VERIFICATION),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

/** A change to a separate S3 target's settings; shared with the compliance export. */
export const s3TargetPatchSchema = z
  .object({
    bucket: z.string().trim().max(255).optional(),
    region: z.string().trim().max(100).optional(),
    endpoint: backupEndpointSchema.nullable().optional(),
    accessKeyId: z.string().trim().max(255).optional(),
    forcePathStyle: z.boolean().optional(),
    /** Omit or send an empty string to keep, send a value to replace, or null to clear. */
    secretAccessKey: z.string().max(2_048).nullable().optional(),
  })
  .strict();

/** Body of `PATCH /admin/backups/settings`: only sent fields change. */
export const updateBackupSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    hourUtc: z.number().int().min(0).max(23).optional(),
    destination: z.enum(BACKUP_DESTINATIONS).optional(),
    prefix: backupPrefixSchema.optional(),
    s3: s3TargetPatchSchema.optional(),
    /** Most recent days kept (the newest backup of each day). */
    keepDaily: z.number().int().min(1).max(90).optional(),
    /** Most recent weeks kept (the newest backup of each ISO week); 0 keeps none beyond the daily ones. */
    keepWeekly: z.number().int().min(0).max(104).optional(),
    copyFiles: z.boolean().optional(),
    verifyFiles: z.enum(BACKUP_FILE_VERIFICATION).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'Send at least one change.' });
export type UpdateBackupSettingsInput = z.infer<typeof updateBackupSettingsSchema>;

export const BACKUP_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

export const backupRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  status: z.enum(BACKUP_RUN_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  destination: z.enum(BACKUP_DESTINATIONS),
  dumpKey: z.string().nullable(),
  dumpBytes: z.number().nullable(),
  dumpSha256: z.string().nullable(),
  manifestKey: z.string().nullable(),
  attachmentCount: z.number().nullable(),
  attachmentBytes: z.number().nullable(),
  missingObjects: z.number().nullable(),
  /** Attachment files copied by this run; null when it did not copy files. */
  files: z
    .object({
      copiedObjects: z.number(),
      copiedBytes: z.number(),
      /** Already at the destination, so not copied again. */
      skippedObjects: z.number(),
      skippedBytes: z.number(),
      /** Read back from the destination and checksummed. */
      verifiedObjects: z.number(),
      /** Unreferenced copies deleted after retention; null until the sweep has run. */
      sweptObjects: z.number().nullable(),
    })
    .nullable(),
  verified: z.boolean(),
  verificationDetail: z.string().nullable(),
  errorMessage: z.string().nullable(),
  prunedAt: z.string().nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

/** `GET /admin/backups`. */
export const backupStatusSchema = z.object({
  settings: backupSettingsSchema,
  /** Why a backup cannot run with these settings; empty when it can. */
  issues: z.array(z.string()),
  /** `pg_dump --version`, or null when the client tools are not installed. */
  pgDumpVersion: z.string().nullable(),
  attachmentStorage: z.object({ driver: z.enum(['local', 's3']), bucket: z.string().nullable() }),
  running: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  runs: z.array(backupRunSchema),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** An audit action, or a prefix such as `user.*` matching every action below it. */
export const webhookActionSchema = z
  .string()
  .trim()
  .max(100)
  .regex(
    /^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/,
    'Use an audit action such as user.create, or a prefix such as user.*.',
  );

const webhookUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url('Enter the endpoint’s full URL, such as https://hooks.example.com/oci.')
  .refine(
    (value) => {
      const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
      return authority !== undefined && !authority.includes('@') && !value.includes('#');
    },
    {
      message: 'Use an https:// URL without a user name, password or #fragment.',
      // Only about a URL: an empty or malformed one has its own complaint,
      // and a second, about user names, only confused it (#301).
      when: (payload) => payload.issues.length === 0,
    },
  );

const webhookFields = z.object({
  url: webhookUrlSchema,
  description: z.string().trim().max(200).default(''),
  /** Ignored when `allActions` is set. */
  actions: z.array(webhookActionSchema).max(100).default([]),
  allActions: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Allows plain HTTP and private, loopback and link-local addresses. */
  allowPrivateNetwork: z.boolean().default(false),
});

/** Body of `POST /admin/webhooks`. */
export const createWebhookSchema = webhookFields
  .strict()
  .refine((input) => input.allActions || input.actions.length > 0, {
    path: ['actions'],
    message: 'Choose at least one audit action, or all of them.',
  });
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

/** Body of `PATCH /admin/webhooks/:id`: only sent fields change. */
export const updateWebhookSchema = patchSchema(webhookFields)
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: 'Send at least one change.' });
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string(),
  actions: z.array(z.string()),
  allActions: z.boolean(),
  enabled: z.boolean(),
  allowPrivateNetwork: z.boolean(),
  secretRotatedAt: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Deliveries waiting for a first attempt or a retry. */
  pendingDeliveries: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/** Returned once, on creation and rotation: the secret is never shown again. */
export const webhookWithSecretSchema = webhookEndpointSchema.extend({ secret: z.string() });
export type WebhookWithSecret = z.infer<typeof webhookWithSecretSchema>;

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliverySchema = z.object({
  id: z.string(),
  event: z.string(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number(),
  maxAttempts: z.number(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

// ---------------------------------------------------------------------------
// Observability (read-only, configured by environment)
// ---------------------------------------------------------------------------

export const observabilityStatusSchema = z.object({
  /** `/metrics` is served (METRICS_TOKEN is set). */
  metrics: z.boolean(),
  /** OpenTelemetry traces are exported (OTEL_EXPORTER_OTLP_ENDPOINT is set). */
  tracing: z.boolean(),
  /** The OTLP endpoint's origin only; never a path, query or credential. */
  tracingEndpoint: z.string().nullable(),
});
export type ObservabilityStatus = z.infer<typeof observabilityStatusSchema>;

// ---------------------------------------------------------------------------
// Scheduled reports
// ---------------------------------------------------------------------------

/**
 * A scheduled usage report. Shared so the admin form's tests refuse a body
 * exactly as the API does (#318).
 */
export const scheduledReportInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  windowDays: z.number().int().min(1).max(365).default(30),
  recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20),
  enabled: z.boolean().default(true),
});
