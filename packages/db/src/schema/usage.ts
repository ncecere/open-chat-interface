import type { QuotaMetric, QuotaWindowKind, ReasoningEffort, UserRole } from '@oci/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

/**
 * The person a usage-reporting row belongs to, cleared rather than cascaded
 * when the account is deleted. Named explicitly: migration 0038 replaced the
 * original cascading key under a new name instead of rewriting it in place.
 */
function keptAfterDeletion(table: string, userId: AnyPgColumn) {
  return foreignKey({
    name: `${table}_user_id_set_null_fk`,
    columns: [userId],
    foreignColumns: [user.id],
  }).onDelete('set null');
}

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

/**
 * Restricts a policy to specific catalog models. A policy with no rows here
 * applies to every model, which is what existing policies do and what an
 * instance-wide budget wants. Membership is an explicit list rather than a
 * lab or provider rule, so curating a new model never silently enrolls it in
 * someone else's budget.
 */
export const quotaPolicyModel = pgTable(
  'quota_policy_model',
  {
    id: primaryId(),
    policyId: text('policy_id')
      .notNull()
      .references(() => quotaPolicy.id, { onDelete: 'cascade' }),
    /** Slug rather than a model FK so a policy survives a catalog removal. */
    modelSlug: text('model_slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('quota_policy_model_unique').on(t.policyId, t.modelSlug),
    index('quota_policy_model_slug_idx').on(t.modelSlug),
  ],
);

/**
 * Raises or lowers one policy's limit for one person.
 *
 * Deliberately not a way to assign a policy: an override only adjusts a limit
 * the user's role already carries. Otherwise it becomes a back door for
 * granting individuals unrelated policies, and "why is this person limited
 * this way?" stops having a single answer.
 *
 * `expiresAt` is evaluated when a limit is read rather than swept, so an
 * override stops applying the moment it lapses instead of at the next job tick.
 */
export const quotaPolicyOverride = pgTable(
  'quota_policy_override',
  {
    id: primaryId(),
    policyId: text('policy_id')
      .notNull()
      .references(() => quotaPolicy.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    limitValue: bigint('limit_value', { mode: 'number' }).notNull(),
    /** Null never expires. Most overrides are temporary in practice. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Why this exists, so a later reader can judge whether it still should. */
    reason: text('reason'),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('quota_policy_override_unique').on(t.policyId, t.userId),
    index('quota_policy_override_user_idx').on(t.userId),
    index('quota_policy_override_expiry_idx').on(t.expiresAt),
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
 * One row per admitted generation attempt. Prices are snapshotted so later
 * catalog edits never rewrite past spend. Reports and budget checks read the
 * hourly rollups below once their backfill has finished (a UTC-day rollup
 * cannot answer a rolling or non-UTC calendar window; an hourly one, with the
 * events of partial hours, can), and these rows before that.
 *
 * `userId` is null once the account is deleted (migration 0038): the usage
 * stays in instance totals and reports as "Deleted accounts", with nothing
 * left that identifies the person.
 */
export const usageEvent = pgTable(
  'usage_event',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    modelSlug: text('model_slug').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer('message_count').notNull().default(1),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    inputPriceMicros: bigint('input_price_micros', { mode: 'number' }),
    outputPriceMicros: bigint('output_price_micros', { mode: 'number' }),
    /**
     * A reservation written before generation so concurrent requests see each
     * other. Settled once the run finishes; a row left pending by a crashed
     * process is recoverable after the TTL only when no active chat claim remains.
     */
    pending: boolean('pending').notNull().default(false),
    /** No complete provider report yet; late actuals may amend the rollup once. */
    usageUnknown: boolean('usage_unknown').notNull().default(false),
    /**
     * Estimated usage not yet replaced by a complete provider report. Holds
     * count inside the quota window even after an unknown completion; they are
     * not measured spend and are never included in daily rollups.
     */
    reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
    reservedTokens: integer('reserved_tokens').notNull().default(0),
    /**
     * True once the event's amounts are in the usage rollups (migration 0040).
     * Set by a trigger on every write, and on older events by the background
     * migration `0.11.usage-rollups`; never written by the application.
     */
    inRollup: boolean('in_rollup'),
  },
  (t) => [
    keptAfterDeletion('usage_event', t.userId),
    index('usage_event_user_occurred_idx').on(t.userId, t.occurredAt),
    index('usage_event_occurred_idx').on(t.occurredAt),
    index('usage_event_model_idx').on(t.modelSlug),
  ],
);

/**
 * Daily count of refused runs, per policy and person.
 *
 * A rollup rather than one row per refusal: a rejected request is cheap to
 * make, so anything scripting against a limit would otherwise write without
 * bound. The policy name is snapshotted the way prices are, so deleting a
 * policy does not erase the history that explains why it was removed.
 *
 * Sustained denials usually mean a limit is set wrong rather than that someone
 * is misbehaving, which is exactly what an administrator currently cannot see.
 * Kept, without the person, when the account is deleted (migration 0038).
 */
export const quotaDenial = pgTable(
  'quota_denial',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    policyId: text('policy_id'),
    policyName: text('policy_name').notNull(),
    modelSlug: text('model_slug').notNull(),
    day: text('day').notNull(),
    denialCount: integer('denial_count').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    keptAfterDeletion('quota_denial', t.userId),
    uniqueIndex('quota_denial_unique').on(t.userId, t.policyId, t.modelSlug, t.day),
    index('quota_denial_day_idx').on(t.day),
  ],
);

/**
 * Daily rollup used by the usage meter and admin analytics. Kept, without the
 * person, when the account is deleted (migration 0038).
 */
export const usageRecord = pgTable(
  'usage_record',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    modelSlug: text('model_slug').notNull(),
    day: text('day').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    keptAfterDeletion('usage_record', t.userId),
    index('usage_record_user_day_idx').on(t.userId, t.day),
    // Concurrent streams previously raced this rollup into duplicate rows.
    uniqueIndex('usage_record_user_model_day_unique').on(t.userId, t.modelSlug, t.day),
  ],
);

/**
 * Amounts summed by the usage rollups (migration 0040). `events` counts every
 * event; `settled*`, `messages`, `tokens*` and `costMicros` are what reports
 * sum (settled events only); `quota*` is what budgets sum (every event, with
 * the estimates still held for unreported usage).
 */
function rollupAmounts() {
  return {
    events: bigint('events', { mode: 'number' }).notNull().default(0),
    settledEvents: bigint('settled_events', { mode: 'number' }).notNull().default(0),
    messages: bigint('messages', { mode: 'number' }).notNull().default(0),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  };
}

function quotaAmounts() {
  return {
    quotaMessages: bigint('quota_messages', { mode: 'number' }).notNull().default(0),
    quotaTokens: bigint('quota_tokens', { mode: 'number' }).notNull().default(0),
    quotaCostMicros: bigint('quota_cost_micros', { mode: 'number' }).notNull().default(0),
  };
}

/**
 * Differences not yet folded into the rollups: written by statement triggers
 * on `usage_event` in the writer's transaction, folded by the job
 * `usage.fold-rollups`. Readers add it to the rollups in the same statement.
 */
export const usageRollupChange = pgTable(
  'usage_rollup_change',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    userId: text('user_id'),
    modelSlug: text('model_slug').notNull(),
    ...rollupAmounts(),
    ...quotaAmounts(),
  },
  (t) => [
    index('usage_rollup_change_hour_idx').on(t.hour),
    index('usage_rollup_change_user_idx').on(t.userId, t.hour),
  ],
);

/**
 * Usage per UTC hour, person and model; `userId` is null for deleted
 * accounts, which share one row (the key is NULLS NOT DISTINCT in 0040).
 */
export const usageRollupHour = pgTable(
  'usage_rollup_hour',
  {
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    userId: text('user_id'),
    modelSlug: text('model_slug').notNull(),
    ...rollupAmounts(),
    ...quotaAmounts(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_rollup_hour_key').on(t.hour, t.userId, t.modelSlug),
    index('usage_rollup_hour_user_idx').on(t.userId, t.hour),
  ],
);

/** Usage per UTC hour and model, for instance-wide figures. */
export const usageRollupModelHour = pgTable(
  'usage_rollup_model_hour',
  {
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    modelSlug: text('model_slug').notNull(),
    ...rollupAmounts(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'usage_rollup_model_hour_pkey', columns: [t.hour, t.modelSlug] })],
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
    /**
     * Insertion order (migration 0034), the compliance export's cursor. Drawn
     * from a sequence by the database; never set by the application.
     */
    seq: bigint('seq', { mode: 'number' }).notNull().default(sql`nextval('audit_log_seq_seq')`),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_idx').on(t.actorUserId),
    uniqueIndex('audit_log_seq_unique').on(t.seq),
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
    mainFont: text('main_font').notNull().default('default'),
    codeFont: text('code_font').notNull().default('default'),
    density: text('density').notNull().default('comfortable'),
    displayName: text('display_name'),
    occupation: text('occupation'),
    traits: jsonb('traits').$type<string[]>().notNull().default([]),
    additionalContext: text('additional_context'),
    /**
     * The person's own starting model and reasoning level (Settings → Models,
     * v0.10; the effort column is migration 0036). Null means the instance
     * default. Checked against what the role allows whenever they are used.
     */
    defaultModelSlug: text('default_model_slug'),
    defaultEffort: text('default_effort').$type<ReasoningEffort>(),
    /**
     * When the introduction was completed. Null means it has not been shown,
     * so a returning user is never asked again after finishing it once.
     */
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    /**
     * The person's own opt-in to user memory (migration 0033), off by default.
     * Memory is used only when this, the instance switch and the role allow it.
     */
    memoryEnabled: boolean('memory_enabled').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('user_preference_user_idx').on(t.userId)],
);
