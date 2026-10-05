import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pgTable } from './_table.js';
import { attachment } from './chat.js';

/**
 * Project files whose passages could not be embedded with the current
 * embeddings model (migration 0029), so the background job backs off instead
 * of retrying them every tick. Written by v0.10; v0.11 uses
 * `embedding_generation_failure` instead (one row per file and generation)
 * and keeps this table only because v0.10 replicas still write it during a
 * rolling upgrade. A later release drops it. A row only applies while `model_key` is the
 * configured model: changing the model gives every file a fresh start. The
 * row is removed once the file's passages are embedded, and goes with the file.
 *
 * The embeddings themselves live in `project_file_embedding`, which is not
 * part of any migration: its `vector(n)` column needs the pgvector extension,
 * which an operator enables, and its size depends on the model. OCI creates it
 * at runtime (see apps/api/src/services/embeddings/storage.ts).
 */
export const projectFileEmbeddingFailure = pgTable(
  'project_file_embedding_failure',
  {
    attachmentId: text('attachment_id')
      .primaryKey()
      .references(() => attachment.id, { onDelete: 'cascade' }),
    modelKey: text('model_key').notNull(),
    failures: integer('failures').notNull().default(1),
    lastError: text('last_error'),
    retryAt: timestamp('retry_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_file_embedding_failure_retry_idx').on(t.retryAt),
    check('project_file_embedding_failure_failures', sql`${t.failures} > 0`),
    check('project_file_embedding_failure_error_length', sql`char_length(${t.lastError}) <= 500`),
  ],
);

export const EMBEDDING_GENERATION_STATES = [
  'filling',
  'current',
  'retired',
  'cancelled',
  'dropped',
] as const;
export type EmbeddingGenerationState = (typeof EMBEDDING_GENERATION_STATES)[number];

/**
 * Embedding generations (migration 0041, v0.11): one row per embeddings
 * configuration (provider, model, dimensions), each with its own vector table
 * created at runtime. Generation 1 keeps the v0.10 name
 * `project_file_embedding`; later ones are `project_file_embedding_g<n>`. See
 * docs/dev/database.md, "Embedding generations".
 */
export const embeddingGeneration = pgTable(
  'embedding_generation',
  {
    id: integer('id').primaryKey(),
    tableName: text('table_name').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    dimensions: integer('dimensions').notNull(),
    modelKey: text('model_key').notNull(),
    inputPriceMicros: bigint('input_price_micros', { mode: 'number' }),
    state: text('state', { enum: EMBEDDING_GENERATION_STATES }).notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    switchForced: boolean('switch_forced').notNull().default(false),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    dropAfter: timestamp('drop_after', { withTimezone: true }),
    droppedAt: timestamp('dropped_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('embedding_generation_id_positive', sql`${t.id} > 0`),
    check(
      'embedding_generation_table_name',
      sql`${t.tableName} = CASE WHEN ${t.id} = 1 THEN 'project_file_embedding' ELSE 'project_file_embedding_g' || ${t.id}::text END`,
    ),
    check('embedding_generation_dimensions', sql`${t.dimensions} > 0 AND ${t.dimensions} <= 16000`),
    check(
      'embedding_generation_state',
      sql`${t.state} IN ('filling', 'current', 'retired', 'cancelled', 'dropped')`,
    ),
    check(
      'embedding_generation_price',
      sql`${t.inputPriceMicros} IS NULL OR ${t.inputPriceMicros} >= 0`,
    ),
    uniqueIndex('embedding_generation_one_current').on(t.state).where(sql`${t.state} = 'current'`),
    uniqueIndex('embedding_generation_one_filling').on(t.state).where(sql`${t.state} = 'filling'`),
  ],
);

/** Files whose passages could not be embedded for one generation (migration 0041). */
export const embeddingGenerationFailure = pgTable(
  'embedding_generation_failure',
  {
    generationId: integer('generation_id')
      .notNull()
      .references(() => embeddingGeneration.id, { onDelete: 'cascade' }),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => attachment.id, { onDelete: 'cascade' }),
    failures: integer('failures').notNull().default(1),
    lastError: text('last_error'),
    retryAt: timestamp('retry_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'embedding_generation_failure_pk',
      columns: [t.generationId, t.attachmentId],
    }),
    index('embedding_generation_failure_attachment_idx').on(t.attachmentId),
    check('embedding_generation_failure_failures', sql`${t.failures} > 0`),
    check('embedding_generation_failure_error_length', sql`char_length(${t.lastError}) <= 500`),
  ],
);
