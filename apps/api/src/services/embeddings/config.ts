import type { EmbeddingsSettings } from '@oci/shared';
import { getSetting, invalidateSettingsCache, type StoredEmbeddingsSettings } from '../settings.js';

/** Fills in defaults for a setting that was never saved, or saved in part. */
export function normalizeEmbeddingsSettings(
  stored: StoredEmbeddingsSettings | null | undefined,
): EmbeddingsSettings {
  return {
    enabled: stored?.enabled === true,
    providerId: stored?.providerId ?? null,
    modelId: stored?.modelId ?? null,
    dimensions: stored?.dimensions ?? null,
    inputPriceMicros: stored?.inputPriceMicros ?? null,
  };
}

/**
 * The embeddings setting. `fresh` bypasses the per-process cache, for the
 * background job: a replica that has not yet seen an administrator's change
 * must not create storage for, or embed with, the previous model.
 */
export async function embeddingsSettings(
  options: { fresh?: boolean } = {},
): Promise<EmbeddingsSettings> {
  if (options.fresh) invalidateSettingsCache('embeddings');
  return normalizeEmbeddingsSettings(await getSetting('embeddings'));
}

/** A setting complete enough to embed with: on, with a model and its dimensions. */
export type ActiveEmbeddingsSettings = EmbeddingsSettings & {
  enabled: true;
  providerId: string;
  modelId: string;
  dimensions: number;
};

export function isActive(settings: EmbeddingsSettings): settings is ActiveEmbeddingsSettings {
  return Boolean(
    settings.enabled && settings.providerId && settings.modelId && settings.dimensions,
  );
}

/**
 * Identifies the vectors one model produces. Stored with every embedding, so
 * a change of provider, model or dimensions makes old vectors invisible to
 * search at once and the background job replaces them.
 */
export function embeddingModelKey(settings: ActiveEmbeddingsSettings): string {
  return `${settings.providerId}/${settings.modelId}/${settings.dimensions}`;
}

const EMBEDDING_USAGE_PREFIX = 'embedding:';

/** The model name usage events are recorded under; embeddings models are not in the catalog. */
export function embeddingUsageSlug(modelId: string): string {
  return `${EMBEDDING_USAGE_PREFIX}${modelId}`;
}

/**
 * The embeddings model a usage event's model name stands for, or null for a
 * chat model. Reports name it by its model ID rather than the internal key
 * (#263).
 */
export function embeddingModelOfUsageSlug(slug: string): string | null {
  return slug.startsWith(EMBEDDING_USAGE_PREFIX)
    ? slug.slice(EMBEDDING_USAGE_PREFIX.length) || null
    : null;
}
