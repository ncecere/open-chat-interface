import { and, asc, eq, schema } from '@oci/db';
import type { CatalogModel, UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { forbidden, notFound, providerError } from '../lib/errors.js';
import { createLanguageModel, type ProviderCredentials } from './providers/registry.js';

/** Models the given role may select, ordered for the picker. */
export async function listAvailableModels(role: UserRole): Promise<CatalogModel[]> {
  const rows = await db
    .select({ model: schema.model, provider: schema.provider })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(and(eq(schema.model.enabled, true), eq(schema.provider.enabled, true)))
    .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName));

  return rows
    .filter(({ model }) => model.visibleToRoles.includes(role))
    .map(({ model, provider }) => ({
      id: model.id,
      slug: model.slug,
      displayName: model.displayName,
      description: model.description,
      providerId: model.providerId,
      providerKind: provider.kind,
      providerLabel: provider.label,
      upstreamModelId: model.upstreamModelId,
      capabilities: model.capabilities,
      costTier: model.costTier,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportedEfforts: model.supportedEfforts,
      isDefault: model.isDefault,
      sortOrder: model.sortOrder,
    }));
}

interface ResolvedModel {
  languageModel: ReturnType<typeof createLanguageModel>;
  slug: string;
  displayName: string;
  maxOutputTokens: number | null;
  capabilities: string[];
}

/**
 * Resolves a catalog slug to a ready language model, enforcing that the model
 * is enabled and visible to the caller's role. Client input never reaches the
 * provider as a raw model ID.
 */
export async function resolveModelForRole(slug: string, role: UserRole): Promise<ResolvedModel> {
  const [row] = await db
    .select({ model: schema.model, provider: schema.provider })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(eq(schema.model.slug, slug))
    .limit(1);

  if (!row) throw notFound('That model is not available');
  if (!row.model.enabled || !row.provider.enabled) {
    throw forbidden('That model is currently disabled');
  }
  if (!row.model.visibleToRoles.includes(role)) {
    throw forbidden('You do not have access to that model');
  }

  const credentials: ProviderCredentials = {
    kind: row.provider.kind,
    label: row.provider.label,
    apiKey: row.provider.encryptedApiKey ? decryptSecret(row.provider.encryptedApiKey) : null,
    baseUrl: row.provider.baseUrl,
  };

  if (!credentials.apiKey && credentials.kind !== 'openai-compatible') {
    throw providerError(`${row.provider.label} has no API key configured`);
  }

  return {
    languageModel: createLanguageModel(credentials, row.model.upstreamModelId),
    slug: row.model.slug,
    displayName: row.model.displayName,
    maxOutputTokens: row.model.maxOutputTokens,
    capabilities: row.model.capabilities,
  };
}
