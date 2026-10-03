import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

/**
 * A legal hold on one person (migration 0034). While a row with no
 * `lifted_at` exists, retention, trash purging, temporary chat expiry and
 * account deletion skip that person's data; a trigger on `user` refuses the
 * deletion itself. Lifted holds stay as history.
 */
export const legalHold = pgTable(
  'legal_hold',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The address when the hold was placed, so history reads after an email change. */
    userEmail: text('user_email').notNull(),
    reason: text('reason').notNull(),
    placedByUserId: text('placed_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    placedByEmail: text('placed_by_email'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedByUserId: text('lifted_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    liftedByEmail: text('lifted_by_email'),
    liftReason: text('lift_reason'),
  },
  (t) => [
    uniqueIndex('legal_hold_active_unique').on(t.userId).where(sql`${t.liftedAt} is null`),
    index('legal_hold_placed_idx').on(t.placedAt),
    check('legal_hold_reason_length', sql`char_length(${t.reason}) between 1 and 1000`),
    check(
      'legal_hold_lift_reason_length',
      sql`${t.liftReason} is null or char_length(${t.liftReason}) <= 1000`,
    ),
  ],
);

/**
 * How far each compliance export stream has been written and verified:
 * every row with a sequence number at or below `last_seq` is in an object.
 */
export const complianceExportCursor = pgTable(
  'compliance_export_cursor',
  {
    stream: text('stream').$type<'audit' | 'messages'>().primaryKey(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastRunId: text('last_run_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('compliance_export_cursor_stream', sql`${t.stream} in ('audit', 'messages')`)],
);

/**
 * One compliance export attempt (migration 0034). The object keys are set
 * before anything is uploaded, so a run interrupted mid-way can be found and
 * its objects removed: nothing it wrote is left to duplicate the next run.
 */
export const complianceExportRun = pgTable(
  'compliance_export_run',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    trigger: text('trigger').$type<'schedule' | 'manual'>().notNull(),
    status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    destination: text('destination').$type<'storage' | 'separate'>().notNull(),
    keyPrefix: text('key_prefix').notNull(),
    includeContent: boolean('include_content').notNull().default(false),
    auditKey: text('audit_key'),
    /** The cursor before this run; the run holds sequence numbers above it. */
    auditAfterSeq: bigint('audit_after_seq', { mode: 'number' }),
    /** Up to and including this sequence number; the next run starts after it. */
    auditThroughSeq: bigint('audit_through_seq', { mode: 'number' }),
    auditCount: integer('audit_count'),
    auditFirstId: text('audit_first_id'),
    auditLastId: text('audit_last_id'),
    auditBytes: bigint('audit_bytes', { mode: 'number' }),
    auditSha256: text('audit_sha256'),
    messagesKey: text('messages_key'),
    messagesAfterSeq: bigint('messages_after_seq', { mode: 'number' }),
    messagesThroughSeq: bigint('messages_through_seq', { mode: 'number' }),
    messageCount: integer('message_count'),
    messagesFirstId: text('messages_first_id'),
    messagesLastId: text('messages_last_id'),
    messagesBytes: bigint('messages_bytes', { mode: 'number' }),
    messagesSha256: text('messages_sha256'),
    manifestKey: text('manifest_key'),
    manifestSha256: text('manifest_sha256'),
    verified: boolean('verified').notNull().default(false),
    errorMessage: text('error_message'),
    /** A failed run whose objects could not be deleted yet; retried by the next run. */
    cleanupPending: boolean('cleanup_pending').notNull().default(false),
    prunedAt: timestamp('pruned_at', { withTimezone: true }),
  },
  (t) => [
    index('compliance_export_run_started_idx').on(t.startedAt),
    check('compliance_export_run_trigger', sql`${t.trigger} in ('schedule', 'manual')`),
    check('compliance_export_run_status', sql`${t.status} in ('running', 'succeeded', 'failed')`),
  ],
);
