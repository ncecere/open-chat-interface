import { jsonb, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';

/**
 * Single-tenant today: exactly one row is seeded and referenced everywhere.
 * The column exists so multi-tenancy is an additive change later.
 */
export const organization = pgTable(
  'organization',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('organization_slug_unique').on(t.slug)],
);

/**
 * Key/value instance configuration. Values are JSON documents validated by
 * Zod schemas in @oci/shared at read time.
 */
export const instanceSetting = pgTable(
  'instance_setting',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [uniqueIndex('instance_setting_key_unique').on(t.organizationId, t.key)],
);
