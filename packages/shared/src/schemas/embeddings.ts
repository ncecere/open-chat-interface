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

/**
 * "Switch now" for the generation being filled. `force` switches before it
 * covers every passage; the passages it misses are found by keyword only
 * until the job embeds them.
 */
export const embeddingsSwitchSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();

export interface EmbeddingsTestResult {
  ok: boolean;
  /** Length of the vector the model returned, when it worked. */
  dimensions?: number;
  /** What went wrong, in words for an administrator. */
  message?: string;
}

/**
 * Embedding generations (v0.11): each embeddings configuration (provider,
 * model, dimensions) is a generation with its own storage. Changing the model
 * fills a new generation in the background while searches keep using the
 * current one, then switches to it.
 *
 * - `filling`: being embedded; new passages are written to it as well.
 * - `current`: what searches use.
 * - `retired`: searched no more; its storage is dropped after a grace period.
 * - `cancelled`: a rebuild abandoned before its switch.
 * - `dropped`: its storage is gone; kept as history.
 */
export const EMBEDDING_GENERATION_STATES = [
  'filling',
  'current',
  'retired',
  'cancelled',
  'dropped',
] as const;
export type EmbeddingGenerationState = (typeof EMBEDDING_GENERATION_STATES)[number];

/** Why a filling generation cannot be switched to yet, if anything stops it. */
export type EmbeddingSwitchBlock =
  /**
   * The current generation is generation 1, whose table the previous release
   * still reads; switching waits until this release's post-deploy steps
   * (`migrate --post`) say every replica runs it.
   */
  'upgrade-in-progress';

export interface EmbeddingGenerationStatus {
  id: number;
  state: EmbeddingGenerationState;
  providerId: string;
  modelId: string;
  dimensions: number;
  inputPriceMicros: number | null;
  createdAt: string;
  switchedAt: string | null;
  /** For a retired generation: when its storage is dropped. */
  dropAfter: string | null;
  /** Whether its storage exists at the right size. */
  storageReady: boolean;
  /**
   * Its storage: `ready`, `missing` (not created yet), `mismatch` (a table of
   * another size: the model was changed on a replica of the previous release
   * during an upgrade) or `unavailable` (pgvector not enabled).
   */
  storage: 'ready' | 'missing' | 'mismatch' | 'unavailable';
  /** Passages of live project files, and how many have a vector in this generation. */
  passages: { total: number; embedded: number };
  /** Vectors written per minute recently (the last ten minutes). */
  perMinute: number;
  /** Estimated seconds until every passage is embedded at that rate; null when not moving. */
  etaSeconds: number | null;
  failures: { files: number; lastError: string | null };
}

export interface EmbeddingsStatus {
  /**
   * The configuration an administrator chose: while a rebuild runs, the new
   * (filling) model, not the one searches still use.
   */
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
  /** The generation searches use, the one being filled, and retired ones not dropped yet. */
  generations: {
    current: EmbeddingGenerationStatus | null;
    filling: EmbeddingGenerationStatus | null;
    retired: EmbeddingGenerationStatus[];
    /** Set while a generation is being filled but cannot be switched to, even when complete. */
    switchBlocked: EmbeddingSwitchBlock | null;
  };
  /**
   * For the cost of a model change before it is saved: passages a new model
   * would embed, and their average length in tokens (estimated from
   * characters, about four per token).
   */
  estimate: { passages: number; averageTokens: number };
}

/** Embedding cost in micro-dollars, or null when no price is known. */
export function embeddingCostMicros(
  estimate: { passages: number; averageTokens: number },
  inputPriceMicros: number | null | undefined,
): number | null {
  if (inputPriceMicros === null || inputPriceMicros === undefined) return null;
  return Math.ceil((estimate.passages * estimate.averageTokens * inputPriceMicros) / 1_000_000);
}

export type EmbeddingsSettings = z.infer<typeof embeddingsSettingsSchema>;
export type UpdateEmbeddingsInput = z.infer<typeof updateEmbeddingsSchema>;
export type EmbeddingsTestInput = z.infer<typeof embeddingsTestSchema>;
