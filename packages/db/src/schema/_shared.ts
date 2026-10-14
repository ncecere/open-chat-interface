import { sql } from 'drizzle-orm';
import { customType, text, timestamp } from 'drizzle-orm/pg-core';

/** A PostgreSQL full-text search vector (read and written as its text form). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Generated UUID primary key column. */
export const primaryId = () => text('id').primaryKey().default(sql`gen_random_uuid()::text`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
