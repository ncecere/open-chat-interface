import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { eq, schema } from '@oci/db';
import { providerCanEmbed } from '@oci/shared';
import type { EmbeddingModel } from 'ai';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError } from '../../lib/errors.js';
import type { ProviderCredentials } from '../providers/registry.js';

/**
 * Builds an AI SDK embeddings model for an administrator's provider. Anthropic
 * offers no embeddings, so it is refused. The model id is the administrator's
 * own entry, never client input from a chat.
 */
export function createEmbeddingModel(
  credentials: ProviderCredentials,
  modelId: string,
): Exclude<EmbeddingModel, string> {
  switch (credentials.kind) {
    case 'openai':
      return createOpenAI({
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.baseUrl && { baseURL: credentials.baseUrl }),
      }).embedding(modelId);
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.baseUrl && { baseURL: credentials.baseUrl }),
      }).embedding(modelId);
    case 'openai-compatible':
      if (!credentials.baseUrl) {
        throw providerError('OpenAI-compatible providers require a base URL');
      }
      return createOpenAICompatible({
        name: credentials.label,
        baseURL: credentials.baseUrl,
        apiKey: credentials.apiKey ?? undefined,
      }).embeddingModel(modelId);
    default:
      throw providerError(`${credentials.label} cannot create embeddings`);
  }
}

/**
 * The embeddings model for a saved or proposed provider and model id. The
 * provider must exist, be enabled and be able to embed.
 */
export async function resolveEmbeddingModel(
  providerId: string,
  modelId: string,
): Promise<Exclude<EmbeddingModel, string>> {
  const [provider] = await db
    .select()
    .from(schema.provider)
    .where(eq(schema.provider.id, providerId))
    .limit(1);
  if (!provider) throw providerError('The embeddings provider no longer exists');
  if (!provider.enabled) throw providerError(`${provider.label} is disabled`);
  if (!providerCanEmbed(provider.kind)) {
    throw providerError(`${provider.label} cannot create embeddings`);
  }
  const apiKey = provider.encryptedApiKey ? decryptSecret(provider.encryptedApiKey) : null;
  if (!apiKey && provider.kind !== 'openai-compatible') {
    throw providerError(`${provider.label} has no API key configured`);
  }
  return createEmbeddingModel(
    { kind: provider.kind, label: provider.label, apiKey, baseUrl: provider.baseUrl },
    modelId,
  );
}
