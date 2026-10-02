import type { RerankingSettings } from '@oci/shared';
import { getSetting, invalidateSettingsCache, type StoredRerankingSettings } from '../settings.js';

/** Fills in defaults for a setting that was never saved, or saved in part. */
export function normalizeRerankingSettings(
  stored: StoredRerankingSettings | null | undefined,
): RerankingSettings {
  return {
    enabled: stored?.enabled === true,
    providerId: stored?.providerId ?? null,
    modelId: stored?.modelId ?? null,
    searchPriceMicros: stored?.searchPriceMicros ?? null,
  };
}

/** The reranking setting; `fresh` bypasses the per-process cache. */
export async function rerankingSettings(
  options: { fresh?: boolean } = {},
): Promise<RerankingSettings> {
  if (options.fresh) invalidateSettingsCache('reranking');
  return normalizeRerankingSettings(await getSetting('reranking'));
}

/** A setting complete enough to rerank with: on, with a provider and a model. */
type ActiveRerankingSettings = RerankingSettings & {
  enabled: true;
  providerId: string;
  modelId: string;
};

export function isRerankingActive(
  settings: RerankingSettings,
): settings is ActiveRerankingSettings {
  return Boolean(settings.enabled && settings.providerId && settings.modelId);
}

/** The model name usage events are recorded under; reranking models are not in the catalog. */
export function rerankUsageSlug(modelId: string): string {
  return `rerank:${modelId}`;
}
