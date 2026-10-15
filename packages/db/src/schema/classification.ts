import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { project, thread } from './chat.js';
import { connector } from './connector.js';
import { organization } from './organization.js';
import { model } from './provider.js';

/**
 * Data classification (migration 0052, #395, docs/admin/data-classification.md).
 *
 * Names live only in `data_class`; every other table holds ids, so a rename is
 * one row and a deleted class cannot leave a dangling reference. Labels
 * restrict deleting a class that is in use; approvals cascade.
 */
export const dataClass = pgTable(
  'data_class',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Hidden from pickers and refuses new labels; what it labels and approves still counts. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('data_class_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    check('data_class_name_length', sql`char_length(${t.name}) between 1 and 60`),
    check('data_class_description_length', sql`char_length(${t.description}) <= 280`),
  ],
);

/** The approvals: classes a model may receive. No row means approved for nothing. */
export const modelDataClass = pgTable(
  'model_data_class',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => model.id, { onDelete: 'cascade' }),
    dataClassId: text('data_class_id')
      .notNull()
      .references(() => dataClass.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'model_data_class_pk', columns: [t.modelId, t.dataClassId] }),
    index('model_data_class_class_idx').on(t.dataClassId),
  ],
);

/** What a connector carries: its results make a conversation hold these classes. */
export const connectorDataClass = pgTable(
  'connector_data_class',
  {
    connectorId: text('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    dataClassId: text('data_class_id')
      .notNull()
      .references(() => dataClass.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'connector_data_class_pk', columns: [t.connectorId, t.dataClassId] }),
    index('connector_data_class_class_idx').on(t.dataClassId),
  ],
);

/** Labels on a project, carried by every conversation in it. `locked`: only an administrator removes it. */
export const projectDataClass = pgTable(
  'project_data_class',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    dataClassId: text('data_class_id')
      .notNull()
      .references(() => dataClass.id, { onDelete: 'restrict' }),
    locked: boolean('locked').notNull().default(false),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'project_data_class_pk', columns: [t.projectId, t.dataClassId] }),
    index('project_data_class_class_idx').on(t.dataClassId),
  ],
);

/**
 * Labels on a conversation. `person`: added by its owner. `kept`: frozen by a
 * trigger when the project or connector that gave the label went away or the
 * conversation left the project; `origin` says which. Forks copy both.
 */
export const threadDataClass = pgTable(
  'thread_data_class',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    dataClassId: text('data_class_id')
      .notNull()
      .references(() => dataClass.id, { onDelete: 'restrict' }),
    source: text('source').$type<'person' | 'kept'>().notNull(),
    /** `project`, or `connector: <name>` for a kept label; empty for a person's. */
    origin: text('origin').notNull().default(''),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'thread_data_class_pk',
      columns: [t.threadId, t.dataClassId, t.source],
    }),
    index('thread_data_class_class_idx').on(t.dataClassId),
    check('thread_data_class_source', sql`${t.source} in ('person', 'kept')`),
  ],
);

/**
 * The sticky fact: the conversation has used a tool of this connector. The
 * connector's classes are read at decision time, so classifying it later
 * reaches conversations that used it before.
 */
export const threadConnectorUse = pgTable(
  'thread_connector_use',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'thread_connector_use_pk', columns: [t.threadId, t.connectorId] }),
    index('thread_connector_use_connector_idx').on(t.connectorId),
  ],
);
