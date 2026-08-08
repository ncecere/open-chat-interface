import type { ModelCapability, ProviderKind, ReasoningEffort, UserRole } from '@oci/shared';
import { bigint, boolean, index, integer, jsonb, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { organization } from './organization.js';

/** Admin-configured upstream provider credentials. */
export const provider = pgTable(
  'provider',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ProviderKind>().notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url'),
    /** AES-256-GCM envelope ciphertext; never returned to clients. */
    encryptedApiKey: text('encrypted_api_key'),
    /** Last four characters for display only. */
    credentialHint: text('credential_hint'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('provider_org_idx').on(t.organizationId)],
);

/**
 * Curated model allowlist. A provider key may grant access to many models;
 * only rows here are exposed to users.
 */
export const model = pgTable(
  'model',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => provider.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    /** Lab slug from the shared MODEL_LABS catalog; drives the displayed logo. */
    labId: text('lab_id'),
    upstreamModelId: text('upstream_model_id').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    capabilities: jsonb('capabilities').$type<ModelCapability[]>().notNull().default([]),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    supportedEfforts: jsonb('supported_efforts').$type<ReasoningEffort[]>().notNull().default([]),
    /** Micro-dollars per million tokens; null means the model is unpriced. */
    inputPriceMicros: bigint('input_price_micros', { mode: 'number' }),
    outputPriceMicros: bigint('output_price_micros', { mode: 'number' }),
    visibleToRoles: jsonb('visible_to_roles')
      .$type<UserRole[]>()
      .notNull()
      .default(['admin', 'user', 'restricted']),
    enabled: boolean('enabled').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('model_slug_unique').on(t.organizationId, t.slug),
    index('model_provider_idx').on(t.providerId),
  ],
);
