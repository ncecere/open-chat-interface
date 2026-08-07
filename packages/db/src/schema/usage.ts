import type { QuotaMetric, QuotaWindowKind, UserRole } from '@oci/shared';
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
 * A named, reusable limit. `limitValue` is in the metric's own unit: messages,
 * tokens, or micro-dollars. Calendar windows reset at midnight in `timezone`.
 */
export const quotaPolicy = pgTable(
  'quota_policy',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    metric: text('metric').$type<QuotaMetric>().notNull(),
    limitValue: bigint('limit_value', { mode: 'number' }).notNull(),
    windowKind: text('window_kind').$type<QuotaWindowKind>().notNull().default('rolling'),
    /** Only used by rolling windows. */
    windowHours: integer('window_hours'),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('quota_policy_org_name_unique').on(t.organizationId, t.name),
    index('quota_policy_org_idx').on(t.organizationId),
  ],
);

/** Applies a policy to a role. A role may carry several policies at once. */
export const quotaPolicyRole = pgTable(
  'quota_policy_role',
  {
    id: primaryId(),
    policyId: text('policy_id')
      .notNull()
      .references(() => quotaPolicy.id, { onDelete: 'cascade' }),
    role: text('role').$type<UserRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('quota_policy_role_unique').on(t.policyId, t.role),
    index('quota_policy_role_role_idx').on(t.role),
  ],
);

/**
 * One row per completed generation. Policy evaluation reads these because a
 * daily rollup cannot answer a rolling or non-UTC calendar window correctly.
 * Prices are snapshotted so later catalog edits never rewrite past spend.
 */
export const usageEvent = pgTable(
  'usage_event',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    modelSlug: text('model_slug').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer('message_count').notNull().default(1),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    inputPriceMicros: bigint('input_price_micros', { mode: 'number' }),
    outputPriceMicros: bigint('output_price_micros', { mode: 'number' }),
  },
  (t) => [index('usage_event_user_occurred_idx').on(t.userId, t.occurredAt)],
);

/** Daily rollup used by the usage meter and admin analytics. */
export const usageRecord = pgTable(
  'usage_record',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    modelSlug: text('model_slug').notNull(),
    day: text('day').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('usage_record_user_day_idx').on(t.userId, t.day),
    // Concurrent streams previously raced this rollup into duplicate rows.
    uniqueIndex('usage_record_user_model_day_unique').on(t.userId, t.modelSlug, t.day),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_idx').on(t.actorUserId),
  ],
);

export const userPreference = pgTable(
  'user_preference',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' })
      .unique(),
    theme: text('theme').notNull().default('dark'),
    boringMode: boolean('boring_mode').notNull().default(false),
    mainFont: text('main_font').notNull().default('default'),
    codeFont: text('code_font').notNull().default('default'),
    density: text('density').notNull().default('comfortable'),
    displayName: text('display_name'),
    occupation: text('occupation'),
    traits: jsonb('traits').$type<string[]>().notNull().default([]),
    additionalContext: text('additional_context'),
    defaultModelSlug: text('default_model_slug'),
    ...timestamps(),
  },
  (t) => [index('user_preference_user_idx').on(t.userId)],
);
