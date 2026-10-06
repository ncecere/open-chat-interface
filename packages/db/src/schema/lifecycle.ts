import type { UserRole } from '@oci/shared';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

/**
 * Objects awaiting deletion from the storage backend.
 *
 * A database trigger writes here whenever an attachment row disappears, which
 * is the only reliable way to catch `ON DELETE CASCADE`: PostgreSQL removes
 * the row without ever calling the application's storage service. Explicit
 * deletes land here through the same trigger, so there is exactly one path.
 *
 * A worker drains the queue. Failures stay queued with a growing attempt count
 * instead of becoming a log line nobody reads.
 */
export const deletedObject = pgTable(
  'deleted_object',
  {
    id: primaryId(),
    storageKey: text('storage_key').notNull(),
    /** Retained for reporting; the row it came from is already gone. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    userId: text('user_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Backoff gate; the worker ignores rows until this time passes. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deleted_object_pending_idx').on(t.deletedAt, t.nextAttemptAt),
    index('deleted_object_key_idx').on(t.storageKey),
  ],
);

/**
 * A published acceptable use policy.
 *
 * Versioned rather than edited in place, because acceptance is a record of
 * what a specific person agreed to at a specific time. Rewriting the text
 * under an existing acceptance would make that record a lie.
 */
export const usagePolicy = pgTable(
  'usage_policy',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Increments on each publish; the highest is the one in force. */
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Null while a draft; set when it becomes the policy people must accept. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('usage_policy_org_version_unique').on(t.organizationId, t.version),
    index('usage_policy_published_idx').on(t.publishedAt),
  ],
);

/**
 * A person's acceptance of one policy version.
 *
 * The compliance artifact: who agreed, to which version, when, and from where.
 * Deliberately not a boolean on the user, which could not answer "what did
 * they actually agree to?" after the text changed.
 *
 * `onDelete: 'restrict'` on the policy prevents deleting a version that
 * somebody has accepted, since that would destroy the evidence.
 */
export const usagePolicyAcceptance = pgTable(
  'usage_policy_acceptance',
  {
    id: primaryId(),
    policyId: text('policy_id')
      .notNull()
      .references(() => usagePolicy.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Snapshotted so the record survives any later renumbering. */
    policyVersion: integer('policy_version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
  },
  (t) => [
    uniqueIndex('usage_policy_acceptance_unique').on(t.policyId, t.userId),
    index('usage_policy_acceptance_user_idx').on(t.userId),
  ],
);

/**
 * An announcement shown to users in the application.
 *
 * Deliberately not email: this is for things people should see while using the
 * instance, such as planned downtime, and it reaches everyone without needing
 * SMTP configured.
 */
export const broadcast = pgTable(
  'broadcast',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    level: text('level').$type<'info' | 'warning' | 'critical'>().notNull().default('info'),
    /** Empty means everyone; otherwise only these roles see it. */
    audienceRoles: jsonb('audience_roles').$type<UserRole[]>().notNull().default([]),
    /**
     * A critical announcement can be made non-dismissable, for something a
     * user genuinely must not miss. Used sparingly: an undismissable banner is
     * an imposition.
     */
    dismissable: boolean('dismissable').notNull().default(true),
    published: boolean('published').notNull().default(false),
    /** Null starts immediately on publish; null end never expires. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [index('broadcast_active_idx').on(t.published, t.startsAt, t.endsAt)],
);

/**
 * Which announcements a person has dismissed.
 *
 * A row per dismissal rather than a flag on the broadcast, because dismissal
 * is per person: one user hiding an announcement must not hide it for anyone
 * else.
 */
export const broadcastDismissal = pgTable(
  'broadcast_dismissal',
  {
    id: primaryId(),
    broadcastId: text('broadcast_id')
      .notNull()
      .references(() => broadcast.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('broadcast_dismissal_unique').on(t.broadcastId, t.userId)],
);

/**
 * Bookkeeping for the background job runner. Answers the first question an
 * operator asks after enabling retention: did it actually run, and what did
 * it touch?
 */
export const jobRun = pgTable(
  'job_run',
  {
    id: primaryId(),
    jobName: text('job_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    status: text('status').$type<'running' | 'success' | 'error'>().notNull().default('running'),
    errorMessage: text('error_message'),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [index('job_run_name_started_idx').on(t.jobName, t.startedAt)],
);

/**
 * A live byte and file counter per user, maintained transactionally alongside
 * attachment writes. Summing `size_bytes` on every upload is correct but scans
 * more rows as history grows, and quota checks sit on the upload hot path.
 *
 * Soft-deleted bytes are tracked separately: they stop counting against the
 * user's allowance immediately so cleaning up frees space at once, while the
 * operator still sees real disk consumption.
 */
export const storageUsage = pgTable(
  'storage_usage',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' })
      .unique(),
    liveBytes: bigint('live_bytes', { mode: 'number' }).notNull().default(0),
    liveFileCount: integer('live_file_count').notNull().default(0),
    pendingBytes: bigint('pending_bytes', { mode: 'number' }).notNull().default(0),
    pendingFileCount: integer('pending_file_count').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('storage_usage_user_idx').on(t.userId)],
);

/**
 * Per-role storage allowance. Unlike a quota, storage is a gauge rather than a
 * flow: it asks how much a user holds right now, so it needs no window,
 * reservation, or settlement.
 */
export const storagePolicy = pgTable(
  'storage_policy',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').$type<UserRole>().notNull(),
    /** Null means unlimited for that dimension. */
    maxTotalBytes: bigint('max_total_bytes', { mode: 'number' }),
    maxFileCount: integer('max_file_count'),
    maxFileBytes: bigint('max_file_bytes', { mode: 'number' }),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('storage_policy_org_role_unique').on(t.organizationId, t.role)],
);

/**
 * A named set of list filters an administrator returns to.
 *
 * Stored per person rather than per instance: "accounts I still have to review"
 * is a working note, not instance configuration, and two administrators
 * looking at the same directory rarely want the same slice of it.
 */
export const savedView = pgTable(
  'saved_view',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Which list this belongs to, such as `users` or `audit`. */
    surface: text('surface').notNull(),
    name: text('name').notNull(),
    /** The query string, stored whole so a new filter needs no migration. */
    filters: jsonb('filters').$type<Record<string, string>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index('saved_view_user_surface_idx').on(t.userId, t.surface),
    uniqueIndex('saved_view_user_surface_name_unique').on(t.userId, t.surface, t.name),
  ],
);

/**
 * A usage report delivered on a schedule.
 *
 * Sent by email rather than accumulated in the application: somebody who wants
 * a monthly figure will not remember to open a page for it, which is the whole
 * reason the report is scheduled.
 */
export const scheduledReport = pgTable(
  'scheduled_report',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `usage` today; named so another report needs no new table. */
    kind: text('kind').notNull().default('usage'),
    cadence: text('cadence').$type<'daily' | 'weekly' | 'monthly'>().notNull(),
    /** Window the report covers, in days. */
    windowDays: integer('window_days').notNull().default(30),
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    /** The last successful send; a failed attempt does not move it (#352). */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status').$type<'success' | 'error'>(),
    lastError: text('last_error'),
    /** When the last failed attempt was made; the retry pause counts from it (#352). */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** Failed attempts since the last successful send (#352). */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('scheduled_report_enabled_idx').on(t.enabled, t.lastRunAt)],
);
