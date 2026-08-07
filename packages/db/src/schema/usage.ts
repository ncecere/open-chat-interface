import type { UserRole } from '@oci/shared';
import { boolean, index, integer, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

export const roleQuota = pgTable(
  'role_quota',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    role: text('role').$type<UserRole>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    maxMessagesPerWindow: integer('max_messages_per_window'),
    maxTokensPerWindow: integer('max_tokens_per_window'),
    windowHours: integer('window_hours').notNull().default(24),
    ...timestamps(),
  },
  (t) => [index('role_quota_org_role_idx').on(t.organizationId, t.role)],
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
    ...timestamps(),
  },
  (t) => [index('usage_record_user_day_idx').on(t.userId, t.day)],
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
