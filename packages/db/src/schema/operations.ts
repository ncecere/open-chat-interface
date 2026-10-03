import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { organization } from './organization.js';

/**
 * One automated backup attempt (migration 0030): a `pg_dump` archive and an
 * attachment manifest written to S3-compatible storage, then verified. Rows
 * are kept as history after retention deletes the objects (`pruned_at`).
 */
export const backupRun = pgTable(
  'backup_run',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    trigger: text('trigger').$type<'schedule' | 'manual'>().notNull(),
    status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `storage` (the attachment bucket) or `separate` (its own bucket and credentials). */
    destination: text('destination').$type<'storage' | 'separate'>().notNull(),
    keyPrefix: text('key_prefix').notNull(),
    dumpKey: text('dump_key'),
    dumpBytes: bigint('dump_bytes', { mode: 'number' }),
    dumpSha256: text('dump_sha256'),
    manifestKey: text('manifest_key'),
    attachmentsKey: text('attachments_key'),
    attachmentCount: integer('attachment_count'),
    attachmentBytes: bigint('attachment_bytes', { mode: 'number' }),
    /** Attachment rows whose object could not be read when the manifest was made. */
    missingObjects: integer('missing_objects'),
    verified: boolean('verified').notNull().default(false),
    verificationDetail: text('verification_detail'),
    errorMessage: text('error_message'),
    prunedAt: timestamp('pruned_at', { withTimezone: true }),
  },
  (t) => [
    index('backup_run_started_idx').on(t.startedAt),
    check('backup_run_trigger', sql`${t.trigger} in ('schedule', 'manual')`),
    check('backup_run_status', sql`${t.status} in ('running', 'succeeded', 'failed')`),
  ],
);

/**
 * SHA-256 of an attachment object, computed once: objects are written under
 * a fresh key and never overwritten, so a cached checksum stays valid.
 */
export const backupObjectChecksum = pgTable('backup_object_checksum', {
  storageKey: text('storage_key').primaryKey(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An administrator-registered webhook endpoint (migration 0030). Receives
 * the selected audit actions, signed with HMAC-SHA256. The secret is
 * AES-256-GCM ciphertext from `apps/api/src/lib/crypto.ts`, shown only once.
 */
export const webhookEndpoint = pgTable(
  'webhook_endpoint',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** Audit actions delivered; ignored when `all_actions` is set. */
    actions: jsonb('actions').$type<string[]>().notNull().default([]),
    allActions: boolean('all_actions').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    /** Allows plain HTTP and private, loopback and link-local addresses. */
    allowPrivateNetwork: boolean('allow_private_network').notNull().default(false),
    encryptedSecret: text('encrypted_secret').notNull(),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [check('webhook_endpoint_description_length', sql`char_length(${t.description}) <= 200`)],
);

/**
 * One event for one endpoint: the durable queue and its delivery log. The
 * body is stored as sent so every retry signs and sends identical bytes.
 */
export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: primaryId(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: 'cascade' }),
    /** The audit entry this event describes; not a foreign key, since audit retention prunes. */
    auditLogId: text('audit_log_id'),
    event: text('event').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_delivery_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index('webhook_delivery_endpoint_idx').on(t.endpointId, t.createdAt),
    check('webhook_delivery_status', sql`${t.status} in ('pending', 'succeeded', 'failed')`),
  ],
);
