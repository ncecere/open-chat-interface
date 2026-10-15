import { sql } from 'drizzle-orm';
import { check, index, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';
import { model } from './provider.js';
import { quotaPolicy } from './usage.js';

/**
 * A set of people, for budgets and model access (v0.14, #394). A group only
 * ADDS to what a person's role gives; it never removes an access. Every
 * foreign key cascades (never RESTRICT) so a previous-release replica deleting
 * a user, model or budget is never blocked by rows it cannot see. `group` is a
 * reserved word: raw SQL must quote it.
 */
export const group = pgTable(
  'group',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('group_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    check('group_name_length', sql`char_length(${t.name}) between 1 and 80`),
    check(
      'group_description_length',
      sql`${t.description} is null or char_length(${t.description}) <= 300`,
    ),
  ],
);

export type GroupMemberRole = 'member' | 'manager';

/**
 * Membership. A manager is also a member for budgets and models; the role only
 * decides who may add and remove members.
 */
export const groupMember = pgTable(
  'group_member',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<GroupMemberRole>().notNull().default('member'),
    addedByUserId: text('added_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'group_member_pk', columns: [t.groupId, t.userId] }),
    index('group_member_user_idx').on(t.userId),
    check('group_member_role', sql`${t.role} in ('member', 'manager')`),
  ],
);

/** Applies a usage budget to every member of a group, as `quota_policy_role` does for a role. */
export const quotaPolicyGroup = pgTable(
  'quota_policy_group',
  {
    id: primaryId(),
    policyId: text('policy_id')
      .notNull()
      .references(() => quotaPolicy.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('quota_policy_group_unique').on(t.policyId, t.groupId),
    index('quota_policy_group_group_idx').on(t.groupId),
  ],
);

/** Makes a model visible to every member of a group, in addition to `model.visible_to_roles`. */
export const modelGroupAccess = pgTable(
  'model_group_access',
  {
    id: primaryId(),
    modelId: text('model_id')
      .notNull()
      .references(() => model.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_group_access_unique').on(t.modelId, t.groupId),
    index('model_group_access_group_idx').on(t.groupId),
  ],
);
