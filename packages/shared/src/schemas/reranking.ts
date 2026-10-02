import { z } from 'zod';
import type { ProviderKind } from '../constants.js';

/**
 * Optional reranking for project-file search (v0.9): a cross-encoder model,
 * reached through the Cohere-compatible `POST <base URL>/rerank` endpoint of
 * an existing provider, reorders the best search candidates before passages
 * are chosen. Works with keyword-only search as well as with meaning-based
 * search; it does not need pgvector.
 */

/**
 * Provider kinds that can rerank, and only with an explicit base URL: the
 * reranking endpoint is always `<base URL>/rerank`. OpenAI's own API has no
 * reranking, so an OpenAI provider qualifies only when it points at a gateway
 * (such as LiteLLM). Anthropic has no reranking API, and Google's (Vertex AI
 * ranking) is not Cohere-compatible, so neither is offered.
 */
export const RERANK_PROVIDER_KINDS = ['openai', 'openai-compatible'] as const;

export function providerCanRerank(provider: {
  kind: ProviderKind;
  baseUrl: string | null;
}): boolean {
  return (
    (RERANK_PROVIDER_KINDS as readonly string[]).includes(provider.kind) &&
    Boolean(provider.baseUrl?.trim())
  );
}

/**
 * The reranking endpoint of a provider's base URL: `/rerank` appended to its
 * path, so `https://host/v1` becomes `https://host/v1/rerank` (a query
 * string, if any, is kept). Null when the base URL is not an HTTP(S) URL.
 */
export function rerankEndpoint(baseUrl: string | null): string | null {
  const trimmed = baseUrl?.trim() ?? '';
  if (!/^https?:\/\/[^/?#\s]+/i.test(trimmed)) return null;
  const [, path = '', rest = ''] = /^([^?#]*)(.*)$/.exec(trimmed) ?? [];
  return `${path.replace(/\/+$/, '')}/rerank${rest}`;
}

/** How many of the best search candidates are reranked. */
export const RERANK_CANDIDATES = 40;
/** A reply waits at most this long for the reranking model. */
export const RERANK_TIMEOUT_MS = 5_000;
/** A price is per this many searches (reranked messages). */
export const SEARCHES_PER_RERANK_PRICE = 1_000;

export const rerankingSettingsSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Micro-dollars per 1,000 searches; null records usage at no cost. */
  searchPriceMicros: z.number().int().nonnegative().nullable(),
});

export const updateRerankingSchema = z
  .object({
    enabled: z.boolean().optional(),
    providerId: z.string().trim().min(1).max(200).nullable().optional(),
    modelId: z.string().trim().min(1).max(200).nullable().optional(),
    searchPriceMicros: z.number().int().nonnegative().max(1_000_000_000_000).nullable().optional(),
  })
  .strict();

/** Reranks a tiny sample with the model on the page (or the saved one); nothing is stored. */
export const rerankingTestSchema = z
  .object({
    providerId: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface RerankingTestResult {
  ok: boolean;
  /** How long the reranking call took, when it worked. */
  latencyMs?: number;
  /** The URL that was called, when the provider could be resolved. */
  endpoint?: string;
  /** What went wrong, in words for an administrator. */
  message?: string;
}

export interface RerankingStatus {
  settings: z.infer<typeof rerankingSettingsSchema>;
  /** Enabled providers that can rerank, with the endpoint each would be called on. */
  providers: { id: string; label: string; kind: ProviderKind; endpoint: string }[];
  /** The endpoint of the saved provider, or null when none is chosen or it cannot rerank. */
  endpoint: string | null;
  /** Whether replies currently rerank project search results. */
  active: boolean;
}

export type RerankingSettings = z.infer<typeof rerankingSettingsSchema>;
export type UpdateRerankingInput = z.infer<typeof updateRerankingSchema>;
export type RerankingTestInput = z.infer<typeof rerankingTestSchema>;
