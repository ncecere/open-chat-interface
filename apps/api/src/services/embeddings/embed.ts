import type { EmbeddingsSettings } from '@oci/shared';
import { type EmbeddingModel, embedMany } from 'ai';
import {
  type ActiveEmbeddingsSettings,
  embeddingModelKey,
  embeddingsSettings,
  isActive,
} from './config.js';
import { resolveEmbeddingModel } from './model.js';

/** The configured embeddings model, ready to call. */
export interface Embedder {
  settings: ActiveEmbeddingsSettings;
  model: Exclude<EmbeddingModel, string>;
  /** Stored with each vector; see `embeddingModelKey`. */
  key: string;
}

/**
 * The embeddings model to use, or null when meaning-based search is off or
 * not fully configured. Throws when the configured provider cannot be used
 * (removed, disabled, no key); callers fall back to keyword search.
 */
export async function activeEmbedder(options: { fresh?: boolean } = {}): Promise<Embedder | null> {
  const settings = await embeddingsSettings(options);
  if (!isActive(settings)) return null;
  return {
    settings,
    model: await resolveEmbeddingModel(settings.providerId, settings.modelId),
    key: embeddingModelKey(settings),
  };
}

export interface Embedded {
  vectors: number[][];
  /** Tokens the provider reported; 0 when it reported none. */
  tokens: number;
}

/**
 * Embeds `values` in order. Every vector must have the expected length and
 * only finite numbers: anything else would be stored or compared wrongly, so
 * it is an error rather than something to repair.
 */
export async function embedValues(
  model: Exclude<EmbeddingModel, string>,
  values: string[],
  options: { dimensions?: number | null; abortSignal?: AbortSignal; maxRetries?: number } = {},
): Promise<Embedded> {
  if (values.length === 0) return { vectors: [], tokens: 0 };
  const result = await embedMany({
    model,
    values,
    maxRetries: options.maxRetries ?? 1,
    maxParallelCalls: 2,
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
  });
  if (result.embeddings.length !== values.length) {
    throw new Error(
      `The embeddings model returned ${result.embeddings.length} vectors for ${values.length} passages`,
    );
  }
  const expected = options.dimensions ?? result.embeddings[0]?.length ?? 0;
  for (const vector of result.embeddings) {
    if (vector.length !== expected || expected === 0) {
      throw new Error(
        `The embeddings model returned ${vector.length} dimensions; ${expected} were expected`,
      );
    }
    if (!vector.every(Number.isFinite)) {
      throw new Error('The embeddings model returned a vector that is not a list of numbers');
    }
  }
  const tokens = result.usage?.tokens;
  return {
    vectors: result.embeddings,
    tokens: Number.isInteger(tokens) && tokens > 0 ? tokens : 0,
  };
}

export const EMBEDDING_TEST_SAMPLE = 'Open Chat Interface checks that this embeddings model works.';

/** Embeds a sample and reports its dimensions; used when a model is tested or saved. */
export async function testEmbeddingModel(
  settings: Pick<EmbeddingsSettings, 'providerId' | 'modelId'>,
): Promise<{ dimensions: number; tokens: number }> {
  if (!settings.providerId || !settings.modelId) {
    throw new Error('Choose a provider and enter a model id first');
  }
  const model = await resolveEmbeddingModel(settings.providerId, settings.modelId);
  const { vectors, tokens } = await embedValues(model, [EMBEDDING_TEST_SAMPLE], {
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(20_000),
  });
  return { dimensions: vectors[0]!.length, tokens };
}
