import { asc, eq, schema } from '@oci/db';
import {
  providerCanRerank,
  type RerankingSettings,
  type RerankingStatus,
  rerankEndpoint,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError } from '../../lib/errors.js';
import { type RerankResult, rerank } from './client.js';
import { isRerankingActive, rerankingSettings } from './config.js';

/** A provider's reranking endpoint and credentials, ready to call. */
interface Reranker {
  endpoint: string;
  apiKey: string | null;
  /** The provider's label, for error messages. */
  provider: string;
  modelId: string;
}

/**
 * The reranker for a saved or proposed provider and model id. The provider
 * must exist, be enabled and be able to rerank (see `providerCanRerank`); an
 * OpenAI provider (necessarily a gateway, since it has a base URL) needs its
 * key, an OpenAI-compatible server may run without one.
 */
export async function resolveReranker(providerId: string, modelId: string): Promise<Reranker> {
  const [provider] = await db
    .select()
    .from(schema.provider)
    .where(eq(schema.provider.id, providerId))
    .limit(1);
  if (!provider) throw providerError('The reranking provider no longer exists');
  if (!provider.enabled) throw providerError(`${provider.label} is disabled`);
  const endpoint = providerCanRerank(provider) ? rerankEndpoint(provider.baseUrl) : null;
  if (!endpoint) {
    throw providerError(`${provider.label} cannot rerank: it needs an OpenAI-compatible base URL`);
  }
  const apiKey = provider.encryptedApiKey ? decryptSecret(provider.encryptedApiKey) : null;
  if (!apiKey && provider.kind !== 'openai-compatible') {
    throw providerError(`${provider.label} has no API key configured`);
  }
  return { endpoint, apiKey, provider: provider.label, modelId };
}

const RERANK_TEST_QUERY = 'How do I reset my password?';
const RERANK_TEST_DOCUMENTS = [
  'The cafeteria on the ground floor opens at eight in the morning.',
  'To reset your password, open Settings, choose Security and follow the link we email you.',
  'Parking permits are renewed every January at the front desk.',
];

/**
 * Reranks a tiny sample with a provider and model, as the admin test and a
 * save that switches reranking on do. Nothing is stored or recorded as usage.
 */
export async function testReranker(
  settings: Pick<RerankingSettings, 'providerId' | 'modelId'>,
): Promise<{ endpoint: string; latencyMs: number; result: RerankResult }> {
  if (!settings.providerId || !settings.modelId) {
    throw new Error('Choose a provider and enter a model id first');
  }
  const reranker = await resolveReranker(settings.providerId, settings.modelId);
  const started = performance.now();
  const result = await rerank({
    ...reranker,
    model: reranker.modelId,
    query: RERANK_TEST_QUERY,
    documents: RERANK_TEST_DOCUMENTS,
  });
  if (result.ranking.length === 0) {
    throw providerError(`${reranker.provider} returned no reranking results`);
  }
  return {
    endpoint: reranker.endpoint,
    latencyMs: Math.round(performance.now() - started),
    result,
  };
}

/** Everything the Reranking section shows. Never includes credentials. */
export async function rerankingStatus(): Promise<RerankingStatus> {
  const settings = await rerankingSettings({ fresh: true });
  const rows = await db
    .select({
      id: schema.provider.id,
      label: schema.provider.label,
      kind: schema.provider.kind,
      baseUrl: schema.provider.baseUrl,
      enabled: schema.provider.enabled,
    })
    .from(schema.provider)
    .orderBy(asc(schema.provider.label));
  const providers = rows.flatMap((row) => {
    const endpoint = row.enabled && providerCanRerank(row) ? rerankEndpoint(row.baseUrl) : null;
    return endpoint ? [{ id: row.id, label: row.label, kind: row.kind, endpoint }] : [];
  });
  const endpoint = providers.find((provider) => provider.id === settings.providerId)?.endpoint;
  return {
    settings,
    providers,
    endpoint: endpoint ?? null,
    active: isRerankingActive(settings) && endpoint !== undefined,
  };
}
