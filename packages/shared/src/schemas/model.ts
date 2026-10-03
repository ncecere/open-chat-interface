import { z } from 'zod';
import { MODEL_CAPABILITIES, PROVIDER_KINDS, REASONING_EFFORTS, USER_ROLES } from '../constants.js';
import { patchSchema } from './patch.js';

export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);

export const catalogModelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  providerId: z.string(),
  providerKind: z.enum(PROVIDER_KINDS),
  providerLabel: z.string(),
  /** Lab that created the model; see MODEL_LABS. Null when unattributed. */
  labId: z.string().nullable(),
  upstreamModelId: z.string(),
  capabilities: z.array(modelCapabilitySchema),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  supportedEfforts: z.array(z.enum(REASONING_EFFORTS)),
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
});

/**
 * Prices are integer micro-dollars per million tokens, so cost arithmetic never
 * touches a float. Null means "unpriced": cost policies cannot bill the model.
 */
const tokenPriceSchema = z.number().int().nonnegative().max(1_000_000_000).nullable().optional();

/** The context window OCI assumes for a model whose window is not set. */
export const FALLBACK_CONTEXT_WINDOW = 32_768;
/**
 * The output OCI reserves for a model whose output limit is not set: this, or
 * a quarter of the context window if that is smaller.
 */
export const DEFAULT_OUTPUT_TOKENS = 4096;
/** Room kept between the input and the output when budgeting a request. */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 512;
export const MAX_CONTEXT_WINDOW = 10_000_000;
export const MAX_OUTPUT_TOKENS_LIMIT = 1_000_000;

/** The output reserved for a model with these limits (either may be unknown). */
export function effectiveOutputTokens(
  contextWindow: number | null,
  maxOutputTokens: number | null,
): number {
  const window = contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  return maxOutputTokens ?? Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(window / 4));
}

/**
 * Why a context window and output limit cannot be used together, or null.
 * The output limit must leave room for input in the (possibly assumed) window;
 * otherwise every message to the model would be refused.
 */
export function modelLimitsProblem(
  contextWindow: number | null,
  maxOutputTokens: number | null,
): string | null {
  const window = contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  const output = effectiveOutputTokens(contextWindow, maxOutputTokens);
  if (output + CONTEXT_SAFETY_MARGIN_TOKENS >= window) {
    return `The output limit must leave room for input: keep it below ${(
      window - CONTEXT_SAFETY_MARGIN_TOKENS
    ).toLocaleString(
      'en-US',
    )} tokens${contextWindow === null ? ' (the assumed context window, less 512), or set the context window' : ' (the context window, less 512)'}.`;
  }
  return null;
}

export const adminModelSchema = catalogModelSchema.extend({
  inputPriceMicros: z.number().int().nonnegative().nullable(),
  outputPriceMicros: z.number().int().nonnegative().nullable(),
  enabled: z.boolean(),
  visibleToRoles: z.array(z.enum(USER_ROLES)),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const upsertModelSchema = z.object({
  providerId: z.string().min(1),
  labId: z.string().trim().max(60).nullable().optional(),
  upstreamModelId: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes'),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600).nullable().optional(),
  capabilities: z.array(modelCapabilitySchema).default([]),
  contextWindow: z
    .number()
    .int('Context window must be a whole number of tokens.')
    .positive('Context window must be a positive number of tokens.')
    .max(MAX_CONTEXT_WINDOW, 'Context window can be at most 10,000,000 tokens.')
    .nullable()
    .optional(),
  maxOutputTokens: z
    .number()
    .int('Max output must be a whole number of tokens.')
    .positive('Max output must be a positive number of tokens.')
    .max(MAX_OUTPUT_TOKENS_LIMIT, 'Max output can be at most 1,000,000 tokens.')
    .nullable()
    .optional(),
  supportedEfforts: z.array(z.enum(REASONING_EFFORTS)).default([]),
  inputPriceMicros: tokenPriceSchema,
  outputPriceMicros: tokenPriceSchema,
  enabled: z.boolean().default(true),
  visibleToRoles: z.array(z.enum(USER_ROLES)).default(['admin', 'user', 'restricted']),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

/** Omitted fields stay unchanged; create-time defaults do not apply. */
export const updateModelSchema = patchSchema(upsertModelSchema);

export const providerSchema = z.object({
  id: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  label: z.string(),
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  hasCredential: z.boolean(),
  credentialHint: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const upsertProviderSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url().max(500).nullable().optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
  enabled: z.boolean().default(true),
});

export const updateProviderSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.string().trim().url().max(500).nullable().optional(),
    /** Omit or send an empty string to keep, send a value to replace, or null to clear. */
    apiKey: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const discoveredModelSchema = z.object({
  upstreamModelId: z.string(),
  displayName: z.string(),
  alreadyInCatalog: z.boolean(),
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type AdminModel = z.infer<typeof adminModelSchema>;
export type UpsertModelInput = z.infer<typeof upsertModelSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type UpsertProviderInput = z.infer<typeof upsertProviderSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
