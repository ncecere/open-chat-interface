import { z } from 'zod';
import {
  COST_TIERS,
  MODEL_CAPABILITIES,
  PROVIDER_KINDS,
  REASONING_EFFORTS,
  USER_ROLES,
} from '../constants.js';

export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);

export const catalogModelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  providerId: z.string(),
  providerKind: z.enum(PROVIDER_KINDS),
  providerLabel: z.string(),
  upstreamModelId: z.string(),
  capabilities: z.array(modelCapabilitySchema),
  costTier: z.enum(COST_TIERS),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  supportedEfforts: z.array(z.enum(REASONING_EFFORTS)),
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
});

export const adminModelSchema = catalogModelSchema.extend({
  enabled: z.boolean(),
  visibleToRoles: z.array(z.enum(USER_ROLES)),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const upsertModelSchema = z.object({
  providerId: z.string().min(1),
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
  costTier: z.enum(COST_TIERS).default('medium'),
  contextWindow: z.number().int().positive().max(10_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).nullable().optional(),
  supportedEfforts: z.array(z.enum(REASONING_EFFORTS)).default([]),
  enabled: z.boolean().default(true),
  visibleToRoles: z.array(z.enum(USER_ROLES)).default(['admin', 'user', 'restricted']),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

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
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
