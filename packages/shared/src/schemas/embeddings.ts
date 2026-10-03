import { z } from 'zod';
import type { PROVIDER_KINDS, ProviderKind } from '../constants.js';

/**
 * Meaning-based search for project files (v0.9): an embeddings model chosen
 * from an existing provider, used together with the pgvector extension. Both
 * are needed; without either, project search stays keyword-only.
 */

/** Provider kinds that can embed text. Anthropic offers no embeddings API. */
export const EMBEDDING_PROVIDER_KINDS = ['openai', 'google', 'openai-compatible'] as const;
export type EmbeddingProviderKind = (typeof EMBEDDING_PROVIDER_KINDS)[number];

export function providerCanEmbed(kind: ProviderKind): kind is EmbeddingProviderKind {
  return (EMBEDDING_PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** pgvector supports up to 16,000 dimensions for the `vector` type. */
export const MAX_EMBEDDING_DIMENSIONS = 16000;

/**
 * Whether the database can store vectors.
 * - `not-installed`: the server has no pgvector package; the image must change.
 * - `available`: installed on the server but not enabled in this database.
 * - `enabled`: `CREATE EXTENSION vector` has been run.
 */
export const PGVECTOR_STATES = ['not-installed', 'available', 'enabled'] as const;
export type PgvectorState = (typeof PGVECTOR_STATES)[number];

export const PGVECTOR_ENABLE_COMMAND = 'CREATE EXTENSION IF NOT EXISTS vector;';

export const embeddingsSettingsSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Read from a test embedding when the model is saved. */
  dimensions: z.number().int().positive().nullable(),
  /** Micro-dollars per million input tokens; null records usage at no cost. */
  inputPriceMicros: z.number().int().nonnegative().nullable(),
});

export const updateEmbeddingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    providerId: z.string().trim().min(1).max(200).nullable().optional(),
    modelId: z.string().trim().min(1).max(200).nullable().optional(),
    inputPriceMicros: z.number().int().nonnegative().max(1_000_000_000_000).nullable().optional(),
  })
  .strict();

/** Embeds a sample with the model on the page (or the saved one); nothing is stored. */
export const embeddingsTestSchema = z
  .object({
    providerId: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface EmbeddingsTestResult {
  ok: boolean;
  /** Length of the vector the model returned, when it worked. */
  dimensions?: number;
  /** What went wrong, in words for an administrator. */
  message?: string;
}

export interface EmbeddingsStatus {
  settings: z.infer<typeof embeddingsSettingsSchema>;
  pgvector: { state: PgvectorState; version: string | null };
  /** Enabled providers that can embed, for the provider picker. */
  providers: { id: string; label: string; kind: (typeof PROVIDER_KINDS)[number] }[];
  /** Whether replies currently search project files by meaning as well as keywords. */
  active: boolean;
  /** Dimensions of the stored vector column, or null before it is created. */
  storageDimensions: number | null;
  /** Project-file passages, and how many have an embedding from the current model. */
  passages: { total: number; embedded: number };
  /** Files whose embedding failed for the current model and is waiting to be retried. */
  failures: { files: number; lastError: string | null };
}

export type EmbeddingsSettings = z.infer<typeof embeddingsSettingsSchema>;
export type UpdateEmbeddingsInput = z.infer<typeof updateEmbeddingsSchema>;
export type EmbeddingsTestInput = z.infer<typeof embeddingsTestSchema>;
